# OpenScale — HTTP, SSE and Data Protocol

**Version:** 0.5  
**Purpose:** Authoritative firmware/WebUI communication contract  
**Companion documents:** `project-requirements_v0.5.md`, `json-file-formats_v0.5.md`

## 1. Status terminology and conventions

- **Explicit** — directly agreed requirement.
- **Implicit** — accepted direction not separately fixed in all details.
- **ESP decision** — firmware-side decision made in this revision to close a proposal/open point.
- **Deferred** — intentionally not part of the current contract.
- **Open** — still requires agreement.

General conventions:

- Sensor IDs are numeric. Common sample fields are `sensorId`, `n`, `t`, `raw`; `flags` is optional in JSON and present in binary records.
- `n` is a per-sensor unsigned 64-bit sample ID.
- `t` is unsigned 64-bit microseconds since boot, from one monotonic clock shared by all sensors and device events. It is never wall-clock time.
- `raw` is always unsigned 64-bit on the wire (JSON and binary). `rawFormat` in `sensors.json` defines its native bit-pattern interpretation.
- Multi-byte binary fields are little-endian.
- JSON endpoints use `Content-Type: application/json`; binary history uses `application/octet-stream`; SSE uses `text/event-stream`.
- Configuration/data resource GET, PUT and DELETE use the same resource URL. There is no PATCH and no `/api/config/*` route.
- The WebUI and API are same-origin by default. No CORS configuration is required.

**64-bit JSON precision:** `n`, `t`, `raw`, `logEntryId` and other uint64 values are emitted as JSON integer tokens, not rounded floating-point values. The WebUI must use a lossless JSON parser / token-preserving BigInt conversion for these fields; native JavaScript `JSON.parse` into `Number` is insufficient above 2^53−1. Do not encode these values in scientific notation.

## 2. Endpoint summary

### 2.1 Device, status, history and stream

| Method | Path | Purpose | Password-protected when set |
|---|---|---|---|
| GET | `/` | Serve asset selected by `settings.json.http_indexpath` | No |
| GET | `/api/device` | Static product/build/hardware/capability metadata; protocol and file-format versions | No |
| GET | `/api/status` | Runtime status, boot ID, CSRF token and pending changes | No |
| GET | `/api/device-log` | Read bounded per-boot device/network log | No |
| GET | `/api/history` | History range for one sensor | No |
| GET | `/stream` | Multiplexed live SSE stream | No |
| POST | `/api/restart` | Explicit device restart request | Yes |
| GET | `/api/files` | JSON index of assets, data files and API paths | No |

### 2.2 Configuration resources

| Method | Path | Password-protected when set |
|---|---|---|
| GET, PUT, DELETE | `/data/settings/settings.json` | All three |
| GET, PUT, DELETE | `/data/settings/wifi.json` | All three |
| GET, PUT, DELETE | `/data/settings/sensors.json` | PUT and DELETE |
| GET, PUT, DELETE | `/data/settings/units.json` | PUT and DELETE |
| GET, PUT, DELETE | `/data/settings/webui-settings.json` | PUT and DELETE |

`DELETE` on any `/data/settings/<name>.json` resets that resource to its factory default. A subsequent GET returns the default with HTTP 200; it does not return 404. Deleting `settings.json` also clears the administrator password (the factory default has no password), so the client must treat this as a security-sensitive reset.

### 2.3 Calibration and static assets

| Method | Path | Password-protected when set |
|---|---|---|
| GET, PUT, DELETE | `/data/calibration/calibration_<sensorId>_<profileId>.json` | PUT and DELETE |
| GET | `/<static-asset-path>` | No |
| PUT, DELETE | `/<static-asset-path>` | Yes |

Calibration files use gzip-compressed JSON transport/storage. Static assets are also gzip-compressed. Generic static-asset handlers must never access `/data`, `/api`, protected firmware files, or registered API routes.

## 3. WebUI startup and session handling

Recommended startup sequence:

1. `GET /api/status` to obtain `bootId` and `csrfToken`; `GET /api/device` for static metadata.
2. Fetch `sensors.json`, `units.json` and `webui-settings.json`. If a WebUI-owned file is unavailable, use the corresponding embedded WebUI fallback. Fetch `/api/files` to enumerate calibration resources and available assets. Fetch `/api/device-log` to initialise the log view.
3. Open `/stream` and buffer incoming events.
4. For each enabled sensor, fetch history backwards in chunks (initially 5,000 records), then merge buffered live samples, deduplicating on `(sensorId, n)`.
5. Poll `/api/status` every 2–5 seconds. Flash/filesystem details may be refreshed less frequently (10–60 seconds).

### 3.1 Boot detection

`bootId` is generated randomly exactly once per boot and is provided to the WebUI only in `/api/status`. The WebUI compares it on every status poll and after every SSE connection/reconnection. A changed value starts a new session epoch; previous samples remain associated with the earlier epoch because monotonic timestamps restart after reboot. A backwards `n` or `t` is a defensive secondary signal, not a replacement for `bootId`.

The SSE `id:` field embeds the boot ID for globally unique event identity. `/api/status` is the authoritative JSON source of `bootId`; do not duplicate `bootId` as a JSON property in SSE payloads.

### 3.2 Authentication retry

For protected resources, the WebUI initially sends a request without credentials. On HTTP 401 it prompts the user and retries once with `Authorization: Basic …`. When no administrator password is configured, the ESP allows the request without prompting. Read-only public endpoints, SSE and history do not require a password.

## 4. History API

### 4.1 Request

```http
GET /api/history?sensor_id=0&from_id=1000&to_id=5999&limit=5000&format=bin
```

| Parameter | Meaning |
|---|---|
| `sensor_id` | Required numeric sensor ID. Exactly one sensor per request. |
| `from_id`, `to_id` | Optional inclusive range, per-sensor IDs; both must be present or both omitted. Returned in ascending `n` order. |
| `limit` | Optional maximum number of records; default 5,000 and capped by `maxHistoryChunk` reported by the ESP. |
| `format` | `json` (default) or `bin` (`application/octet-stream`). |

If no range is supplied, return the newest `limit` records. If a range is supplied and it contains more than `limit`, return the newest `limit` records within that requested range and set `truncated: true`. This supports backwards pagination: the next request can end at `firstId - 1`. If requested IDs have already been evicted, report the actual retained range. Interior sequence gaps caused by queue drops remain gaps; do not fabricate samples or renumber IDs.

The WebUI prefers binary. It accepts fewer records than requested and must use the returned range metadata rather than assume that a response is complete.

### 4.2 Range metadata

Both JSON and binary responses include these HTTP headers:

```http
X-History-Returned: 5000
X-History-First-Id: 7001
X-History-Last-Id: 12000
X-History-Latest-Id: 12000
X-History-Oldest-Id: 1500
X-History-Truncated: false
X-History-Max-Chunk: 5000
```

Definitions:

- `Returned`: number of records in this response.
- `First-Id`, `Last-Id`: first and last actual sample IDs returned; omit when no records are returned.
- `Latest-Id`, `Oldest-Id`: latest and oldest sample IDs currently retained in that sensor's ring buffer at the response snapshot; omit when the buffer is empty.
- `Truncated`: true when the requested range was clipped by `limit`/maximum chunk or cannot be fully served because one or both requested range boundaries are no longer retained. Interior missing IDs due to acquisition/queue drops do not alone make this true.
- `Max-Chunk`: maximum number of samples the endpoint will return in one response for the current device configuration. This limit is stable for the running configuration and is not changed unpredictably according to momentary free heap.

For JSON, include the same information in the response body. Use `null` for `firstId`/`lastId`/`oldestId`/`latestId` when no corresponding sample exists.

### 4.3 JSON response

```json
{
  "sensorId": 0,
  "samples": [
    { "n": 1001, "t": 123456789012, "raw": 123456, "flags": 0 }
  ],
  "returned": 1,
  "firstId": 1001,
  "lastId": 1001,
  "latestId": 1200,
  "oldestId": 801,
  "truncated": false
}
```

`flags` may be omitted when zero; absence is equivalent to zero. The `latestId` and `oldestId` values describe the retained ring-buffer boundaries, not necessarily the first/last record in this response.

### 4.4 Binary response

Version 1, little-endian, fixed for all sensor types.

**Header: 12 bytes**

| Field | Size | Type / meaning |
|---|---:|---|
| Magic `HIST` | 4 | ASCII bytes `48 49 53 54` |
| Version | 2 | u16; value `1` |
| Header flags | 2 | u16; reserved, send zero |
| Sample count | 4 | u32 record count |

**Record: 28 bytes**

| Field | Size | Type / meaning |
|---|---:|---|
| `n` | 8 | u64 sample ID |
| `t` | 8 | u64 microseconds since boot |
| `raw` | 8 | u64 raw bit pattern |
| `flags` | 4 | u32 flags |

Expected payload length: `12 + sampleCount × 28`. No additional header bytes are present. Binary version is `1`; header flags are reserved. Range metadata is delivered in the HTTP headers, not in extra binary header fields.

### 4.5 Sample flag definitions and retention

The u32 flag bit assignments are:

| Bit | Mask | Meaning |
|---:|---:|---|
| 0 | `0x00000001` | Overload threshold active |
| 1 | `0x00000002` | Underload threshold active |
| 2 | `0x00000004` | Sensor disconnection |
| 3 | `0x00000008` | Sensor error |
| 4 | `0x00000010` | Invalid measurement |
| 5–31 | — | Reserved for future quality indicators; send zero until defined |

Per-sample flags are **not stored in ring-buffer entries**. Bits 0 and 1 are calculated on demand when history/live responses are generated, using the current raw thresholds and the sample's `rawFormat`. Bits 2–4 are defined for protocol compatibility but are not retrospectively reconstructed in history; current disconnection/error state and past affected ranges are provided through sensor events and `/api/device-log`. A live sample may set bit 4 when the driver itself identifies that sample as invalid. All reserved bits are zero.

Because threshold flags are recalculated using current thresholds, history flags do not assert which threshold configuration was active when an older sample was acquired. The WebUI should use warning events/device log for historical state transitions.

### 4.6 Gap filling

When a live `n` jumps, the WebUI requests the missing `from_id`..`to_id` interval. IDs no longer retained remain gaps; the response range metadata identifies eviction/truncation. Queue-dropped IDs are never fabricated.

## 5. SSE `/stream`

### 5.1 Connection behaviour and global event IDs

- One SSE endpoint multiplexes all enabled sensors and device events.
- A new connection starts at the live edge. No history replay and no `Last-Event-ID` replay are implemented; the WebUI fills gaps through `/api/history`.
- Each application event has an SSE `id:` line: `<bootId>-<eventCounter>`, for example `a83f21c9-1042`.
- `eventCounter` is one device-global unsigned 64-bit counter that starts at 1 for each boot and increments for every application event transmitted through SSE. A live event is assigned one ID before broadcast, so all currently connected clients receive the same ID. Each per-connection device-log snapshot frame is assigned its own new global ID. The per-sensor sample ID `n` is independent. SSE keep-alive comments, if used, are not application events and do not consume an event ID.
- Emit one `sample` event per sample. Array batching is not used in this protocol revision. On a new SSE connection, send the retained current-boot device-log entries as `device_log` events (at most 128); this is a log snapshot only, not sample/history replay. The WebUI deduplicates log entries by `logEntryId`, since it may also have fetched them through `/api/device-log`.
- Do not include `bootId` or `eventCounter` again in JSON data; the WebUI gets `bootId` through `/api/status`.

### 5.2 Sample event

```text
id: a83f21c9-1042
event: sample
data: {"sensorId":0,"n":501,"t":123456781,"raw":12345,"flags":0}
```

The SSE event type is `sample`; `data` is the sample JSON object. `t` is the sample acquisition timestamp, not dispatch time.

### 5.3 Warning event

```text
id: a83f21c9-1043
event: warning
data: {"type":"sensor","code":"overload","active":true,"sensor":{"sensorId":0,"threshold":8000000,"sample":{"n":501,"t":123456781,"raw":9388607,"flags":1}}}
```

Emit on state change only, including `active:false` when cleared. `type` is `sensor`; `code` is `overload` or `underload`; `sensor.threshold` is in the sensor's native raw units. `sensor.sample` carries the triggering/current sample context. The event's global SSE ID is distinct from `sample.n`.

### 5.4 Device and sensor-error events

ESP-defined payloads are fixed as follows:

```json
{"state":"restarting","message":"Restart requested","t":123456789}
```

```json
{"sensorId":0,"state":"error","code":"read_timeout","message":"HX711 read timeout","t":123456789,"fromN":1200,"toN":1260}
```

- `device`: `state`, human-readable `message`, monotonic `t`; optional `details` object may carry reason/code.
- `sensor_error`: `sensorId`, `state` (`ok`, `error`, `disconnected`), stable machine-readable `code`, human-readable `message`, monotonic `t`; `fromN`/`toN` are included when a sample range was affected or skipped.

The firmware should emit state transitions, not repeated identical error events on every acquisition attempt.

### 5.5 Device-log event

Use the SSE event name **`device_log`**. Its JSON data is one device-log entry with the exact fields defined in §6.3. Every new entry is emitted as a `device_log` event. The global SSE event counter advances for this event too. Retained entries are also sent to a newly connected client as the log snapshot described in §5.1.

## 6. Device metadata, status and device log

### 6.1 `GET /api/device` — static metadata

Include:

- product name, firmware semantic version, build ID, Git commit and ESP-IDF version;
- chip model/revision/core count;
- physical flash size/type and partition/filesystem information;
- PSRAM presence/type/total size;
- network capabilities and supported features;
- `protocolVersion` (ESP decision: integer major protocol version, currently `1`);
- `fileFormatVersions`, e.g. `{"settings":1,"wifi":1,"sensors":1,"units":1,"webuiSettings":1,"calibration":1,"historyBinary":1}`;
- `maxUploadBytes` (initial default 524288 bytes) and `maxHistoryChunk`.

`bootId` is **not** in `/api/device`.

### 6.2 `GET /api/status` — dynamic status

Example shape:

```json
{
  "bootId": "a83f21c9",
  "uptimeUs": 123456789012,
  "csrfToken": "per-boot-random-token",
  "pendingChanges": ["sensors.json"],
  "unixtimestamp": null,
  "openSseConnections": 1,
  "memory": {
    "heapFree": 120000,
    "heapMinFree": 80000,
    "heapLargestBlock": 64000,
    "psramTotal": 8388608,
    "psramFree": 7000000,
    "psramLargestBlock": 4000000
  },
  "flash": {
    "physicalTotal": 4194304,
    "filesystemTotal": 1900000,
    "filesystemUsed": 400000,
    "filesystemFree": 1500000
  },
  "wifi": {"connected":true,"rssi":-55,"ip":"192.168.1.50","clientsConnected":0},
  "sensors": [
    {
      "sensorId": 0,
      "state": "ok",
      "rate_hz": 80,
      "sensorUptimeUs": 123000000,
      "configRevision": 3,
      "warningRevision": 2,
      "ringBufferCapacity": 1600,
      "ringBufferUsed": 1200,
      "oldestId": 801,
      "latestId": 2000,
      "queueDrops": 0,
      "readErrors": 0
    }
  ]
}
```

Field rules:

- `bootId`: random identifier generated once at boot; this endpoint is its only JSON source.
- `csrfToken`: random per boot; required in `X-CSRF-Token` on every mutating request.
- `pendingChanges`: settings files saved but not yet fully active.
- `unixtimestamp`: Unix time in seconds UTC corresponding to the same status snapshot as `uptimeUs`, or null when wall-clock time is not available/synchronised. The pair provides a wall-clock/monotonic-time correlation; it never changes sample `t`.
- `openSseConnections`: current SSE connection count.
- `wifi.clientsConnected`: AP client count when available; omit if not supported/not applicable.
- Per sensor `rate_hz` is the effective rate, not merely the requested setting.
- `configRevision` (**Explicit**) is a per-sensor monotonic revision within the boot. It starts at 1 each boot and increments only when an actual effective configuration value changes and becomes active in a way that can change sample interpretation or continuity: sensor type, `rawFormat`, effective sampling rate, driver measurement configuration affecting raw measurements, or an explicit buffer clear. A resize with `buffer=preserve` does not increment it unless the operation also clears/restarts the retained sample sequence.
- `warningRevision` (**Explicit**) is a separate per-sensor monotonic revision within the boot. It starts at 1 each boot and increments only when an actual change to the active firmware warning configuration becomes effective (warning enablement, overload/underload threshold, or hysteresis). Warning-only changes do not increment `configRevision` and must not cause the WebUI to start a new sample buffer/continuity segment.
- `sensorUptimeUs` is monotonic time since that sensor entered the running state.
- Flash physical size is distinct from filesystem partition capacity/used/free.

Suggested polling: 2–5 seconds for runtime/memory/Wi-Fi/sensor data; 10–60 seconds for flash/filesystem statistics.

### 6.3 `GET /api/device-log`

The device log is a bounded in-memory ring of the latest 128 entries per boot. It is not persisted to flash, avoiding routine flash wear. `logEntryId` starts at 1 and increases for every entry during the boot; it is independent of sensor sample IDs and the global SSE event counter. `t` is microseconds since boot.

Request:

```http
GET /api/device-log?after_id=16&limit=50
```

- `after_id`: optional; return entries with `logEntryId` greater than this value.
- `limit`: optional; default 128, maximum 128.
- Entries are returned oldest-to-newest.

Response:

```json
{
  "entries": [
    {
      "logEntryId": 17,
      "t": 123456789012,
      "type": "config_fallback",
      "message": "Could not load wifi.json; in-memory defaults are active",
      "details": {"file":"wifi.json","reason":"parse_error","savedFileModified":false}
    }
  ],
  "returned": 1,
  "oldestLogEntryId": 1,
  "latestLogEntryId": 17,
  "truncated": false
}
```

`truncated` is true when the requested cursor predates entries already evicted from the 128-entry log. Without `after_id`, return the full retained log (up to 128 entries). The response does not repeat `bootId`; the WebUI correlates it with `/api/status`.

Standard `type` values and minimum details:

| Type | Minimum `details` |
|---|---|
| `config_fallback` | `file` (`settings.json` or `wifi.json`), `reason`, `savedFileModified:false` |
| `wifi_state` | `state`; optional `ssid`, `ip`, `rssi` (never password) |
| `network_error` | `code`, optional interface/SSID/reason |
| `sensor_error` | `sensorId`, `code`; optional `fromN`, `toN` |
| `sensor_disconnection` | `sensorId`; optional `fromN`, `toN` |
| `warning` | `sensorId`, `code`, `active`, optional `n` and `threshold` |

`message` is human-readable and may change; clients must use `type`/`details` for logic. Future types may be added without changing the schema version. A new entry is also sent through SSE as `event: device_log`.

## 7. Configuration write behaviour

### 7.1 PUT/DELETE response

Successful write/reset responses use HTTP 200 and a JSON body:

```json
{
  "status": "needs-sensor-reconfig",
  "saved": true,
  "errors": [],
  "warnings": [],
  "pendingChanges": ["sensors.json"]
}
```

`status` is one of:

- `applied`: saved and fully active immediately;
- `needs-sensor-reconfig`: saved and requires a sensor driver reconfiguration;
- `needs-restart`: saved but requires an explicit full restart;
- `rejected`: not saved/applied; included for consistency in the body of a 400 validation response.

The firmware compares the new full document with the previous active configuration. WebUI-owned keys and metadata such as `notes`, `kind`, `conversion`, `loadLimits`, `calibrationFile` and `primaryTemperatureSensorId` are stored/preserved without reconfiguring the sensor. Changes to `type`, `rawFormat`, `rate_hz`, driver blocks, raw warning thresholds/hysteresis, or `ringbuffer_size_samples` require at least sensor reconfiguration. The ESP may classify genuine hardware/partition changes as `needs-restart`. Do not restart automatically; the WebUI chooses whether to call `POST /api/restart`.

Ring-buffer resize mode is selected only on `sensors.json` PUT:

```http
PUT /data/settings/sensors.json?buffer=preserve
PUT /data/settings/sensors.json?buffer=clear
```

Default is `preserve`.

For a newly created Wi-Fi entry without `id`, the ESP assigns a stable ID and returns the canonical redacted configuration (with assigned IDs and `passwordSet`) in the response. A submitted full network list defines the new list: an existing ID omitted from the submitted list is deleted.

### 7.1.1 Calibration and static-asset PUT responses

Successful `PUT` requests to `/data/calibration/<name>.json` and `/<static-asset-path>` use the same JSON response structure as configuration writes (**Explicit**). They return HTTP 200 with:

```json
{
  "status": "applied",
  "saved": true,
  "errors": [],
  "warnings": [],
  "pendingChanges": []
}
```

For these resource types, `status` is `applied` once the resource has been stored and is immediately retrievable from its resource URL. `pendingChanges` is empty: storing a calibration blob or static asset does not change active sensor configuration, does not increment `configRevision` or `warningRevision`, and does not require a restart. Calibration content remains an opaque gzip blob to the ESP; this response does not mean that the firmware has parsed, validated or applied the calibration. Static assets are immediately available at their paths after a successful upload. `errors` and `warnings` are empty when the operation succeeds; storage failure uses the existing HTTP error response, especially 507 for insufficient flash space. Invalid static-asset gzip input is rejected according to the static-asset validation rules; calibration bytes are stored unchanged whenever flash space permits.

### 7.2 HTTP status codes and error body

| Code | Use |
|---:|---|
| 200 | Successful GET, PUT, DELETE reset, or action result |
| 400 | Malformed JSON, unsupported schema, failed validation or invalid query |
| 401 | Password required or incorrect |
| 403 | Missing/invalid CSRF token |
| 404 | Unknown resource/path |
| 405 | Method not allowed for resource |
| 413 | Request body exceeds the configured maximum request size |
| 507 | Insufficient flash space to store/replace the resource |
| 500 | Unexpected internal failure |

Preferred error body:

```json
{"error":{"code":"validation_failed","message":"Invalid sensor configuration","details":{"sensorId":0,"field":"rate_hz"}}}
```

The ESP may include a detailed message in any error response. Plain text is permitted when JSON cannot be constructed; the WebUI displays the body text. For a critical configuration failure, do not replace the working file. For calibration upload, store the gzip bytes as-is whenever flash space allows; failure to parse/decompress is not a reason to reject it in this version. Return 507 only when flash cannot store it.

ESP decision: initial maximum single request body is 512 KiB, reported as `maxUploadBytes` in `/api/device`; firmware/build configuration may lower it for a specific partition. A request above that limit returns 413; a request within the limit that cannot fit on flash returns 507.

## 8. Authentication and CSRF

### 8.1 Password rules

Use HTTP Basic authentication when an administrator password has been configured. Apply the endpoint table in §2. The WebUI sends no credentials initially; on 401 it prompts and retries once with `Authorization: Basic …`.

ESP decision: do **not** include `WWW-Authenticate: Basic` on the 401 response, preventing browser-native dialogs from appearing in `fetch` flows. The WebUI owns the prompt. When no administrator password exists, the ESP does not require credentials.

GET of unprotected resources, `/api/status`, `/api/device`, `/api/device-log`, history, `/api/files` and SSE never needs a password. Do not return password fields in any GET body. Passwords are stored as salted PBKDF2-HMAC-SHA256 verifiers; Wi-Fi credentials must remain recoverable for station reconnection and must not be returned by GET. Plain HTTP does not encrypt Basic credentials; use a trusted network until HTTPS works.

### 8.2 CSRF

- `/api/status` returns `csrfToken`, random per boot.
- Every PUT, POST and DELETE must include `X-CSRF-Token` with that value, regardless of whether an administrator password is configured.
- On 403, the WebUI fetches `/api/status` once and retries once with the refreshed token.
- The token is not stored in configuration files.

## 9. Static asset API

Static asset paths are direct root-relative resources. Examples:

```http
GET /custom/index.html
PUT /custom/index.html
DELETE /custom/index.html
```

- Nested paths are supported; the firmware may map them to physical directories or logical paths.
- Static assets are gzip bytes in flash. Uploads send `Content-Encoding: gzip`; responses are served with `Content-Encoding: gzip`.
- Gzip is mandatory for all build types. JSON is allowed as a generic static asset.
- `default.*` is immutable through the generic asset API.
- `/data`, `/api`, registered API routes and other protected/reserved paths are excluded. Prevent path traversal and encoded traversal (`..`, separator tricks, etc.).
- PUT and DELETE require password authentication when a password is set, plus CSRF. GET is public.
- The index asset is selected only by `settings.json.http_indexpath` (default `/default.html`). There is no `/api/files/index` endpoint.

## 10. File index API

`GET /api/files` returns JSON listing all static assets, settings files, calibration files and API paths. It is public; listing paths does not grant read/write access to a protected resource.

Example:

```json
{
  "files": [
    {"path":"/default.html","kind":"asset","contentEncoding":"gzip","sizeBytes":4812,"protected":false,"readOnly":true},
    {"path":"/data/settings/settings.json","kind":"settings","contentEncoding":"identity","sizeBytes":512,"protected":true,"readOnly":false},
    {"path":"/data/calibration/calibration_0_profileA.json","kind":"calibration","contentEncoding":"gzip","sizeBytes":18320,"protected":true,"readOnly":false}
  ],
  "apiPaths": [
    {"path":"/api/status","methods":["GET"]},
    {"path":"/api/history","methods":["GET"]},
    {"path":"/stream","methods":["GET"]}
  ]
}
```

`sizeBytes` is the stored size (compressed size for gzip files); it may be null if unavailable. `modified` may be included as a timestamp if supported. `protected` indicates whether a password is required for any mutating method; it does not mean that all methods on the resource require a password. `apiPaths` describes registered API paths and supported methods; dynamic parameters may be shown as placeholders.

## 11. Calibration API

Calibration file path:

```text
/data/calibration/calibration_<sensorId>_<profileId>.json
```

- `<sensorId>` is a decimal numeric sensor ID.
- `<profileId>` matches `[A-Za-z0-9._-]+`.
- The file also contains the same numeric `sensorId` and a `profileId`; filename and document must agree.
- Any number of profiles may exist for one sensor. `sensors.json.calibrationFile` selects the active profile for a load-cell sensor; the WebUI may temporarily switch profile in browser state without saving it.
- GET, PUT and DELETE use the same path. GET is public; PUT and DELETE require password protection when set and CSRF.
- Upload headers: `Content-Type: application/json`, `Content-Encoding: gzip`. Store bytes as received and serve them with `Content-Encoding: gzip`. The ESP does not decompress or validate calibration JSON in this version.
- `/api/files` lists each file and its stored compressed size.

## 12. HTTP/HTTPS and hostname redirects

HTTP cannot be disabled. If HTTPS is enabled, configured and fully operational, requests received over HTTP redirect to HTTPS, preserving path and query. Until TLS is functional, the ESP must reject `https.enabled: true` and keep HTTP available.

If `redirectToHostname` is enabled, requests addressed by IP may redirect to the mDNS hostname when resolvable. When HTTPS is fully operational, the HTTPS scheme takes precedence; otherwise hostname redirects remain HTTP. Never redirect a request already using the canonical hostname, and avoid loops / redirects when the target name is unavailable.

## 13. Explicit ESP decisions closing prior open points

| Previously open item | Decision |
|---|---|
| Calibration DELETE | Protected when admin password is set, same as PUT |
| Wi-Fi list PUT handling | Complete list; stable IDs match; missing ID creates a new network; omitted existing ID deletes it |
| Warning hysteresis property names | `warnings.overload.hysteresis` and `warnings.underload.hysteresis` |
| Admin password object path | `security.password` (write-only); GET emits `security.passwordSet` |
| Beta `rSeries` | Series resistance is subtracted from measured total resistance |
| Sample flag bits | bit 0 overload, bit 1 underload, bit 2 disconnection, bit 3 sensor error, bit 4 invalid measurement; 5–31 reserved |
| Device-log SSE event name | `device_log` |
| Device-log layout/types/retention | §6.3; 128 entries in per-boot RAM ring, not persisted to flash |
| 401 Basic challenge | Omit `WWW-Authenticate` |
| Upload size | Initial request body limit 512 KiB, exposed as `maxUploadBytes` |
| History query | `sensor_id`, optional paired `from_id`/`to_id`, `limit`, `format`; one sensor per request |
| History response metadata | Adopt `X-History-*` headers and body fields as §4.2/§4.3 |
| Status enrichment | Include `pendingChanges`, `configRevision`, effective `rate_hz`, sensor bounds/uptime, SSE count and optional wall time |
| SSE samples | One `sample` event per sample; no array batching in this revision |

## 14. Deferred / open points

- **Deferred:** HTTPS/TLS, OTA, ETag/`If-Match`, aggregate multi-sensor history, ESP-side calibration decompression/validation and generic `/data/user/` file APIs.
- **Open:** wall-clock source and synchronisation; `unixtimestamp` is null until available.
- **Open:** hardware-specific actual upload/max-history limits may be lower than the defaults and must be reported by the device.
