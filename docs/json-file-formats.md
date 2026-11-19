# OpenScale — JSON File Formats and Examples

**Version:** 0.5  
**Purpose:** Configuration, WebUI-owned files, calibration files and JSON payload reference  
**Companion documents:** `project-requirements_v0.5.md`, `api-protocol_v0.5.md`

## 1. General rules

- Every structured JSON data resource in this document has a top-level integer `schemaVersion: 1`. Additive fields retain version 1; incompatible structural changes require a version increase.
- Sensor IDs are numeric JSON values everywhere.
- Settings/configuration JSON is stored uncompressed. Calibration and future WebUI-owned data blobs are gzip-compressed in transport and storage. Static assets are also gzip-compressed.
- PUT replaces the submitted document; there is no PATCH. The ESP compares the submitted document with active configuration and determines the required effect.
- The ESP preserves unknown keys when it reserializes structured files. WebUI-owned keys in `sensors.json` are stored and returned without interpretation.
- Critical ESP configuration is validated before replacement. If validation fails, the working file/configuration remains unchanged. WebUI-owned settings and calibration files are non-essential.
- `DELETE /data/settings/<name>.json` resets the resource to its factory default; subsequent GET returns HTTP 200 with the default document.
- GET responses never expose password material. Write-only password fields are documented below.

**Status terminology:** **Explicit** = directly agreed; **Implicit** = accepted direction; **ESP decision** = selected to close an open point; **Deferred** = postponed; **Open** = unresolved.

## 2. Files and paths

| File/resource | Path | Owner / ESP behaviour | Storage |
|---|---|---|---|
| System settings | `/data/settings/settings.json` | ESP-owned, interpreted and validated | JSON, uncompressed |
| Wi-Fi settings | `/data/settings/wifi.json` | ESP-owned, interpreted and validated | JSON, uncompressed |
| Sensor definitions | `/data/settings/sensors.json` | ESP driver keys + WebUI-owned keys preserved | JSON, uncompressed |
| Units | `/data/settings/units.json` | WebUI-owned; ESP validates structure only | JSON, uncompressed |
| WebUI defaults | `/data/settings/webui-settings.json` | WebUI-owned; ESP stores/serves opaquely | JSON, uncompressed |
| Calibration | `/data/calibration/calibration_<sensorId>_<profileId>.json` | WebUI-owned; ESP stores/serves opaque gzip bytes | Gzip JSON |
| Generic static assets | `/<static-asset-path>` | WebUI-owned, served as gzip | Gzip bytes |

The structured JSON files use GET/PUT/DELETE on the same resource URL. Authentication and method details are in `api-protocol_v0.5.md`.

## 3. `settings.json` — system settings

### 3.1 Example GET representation

```json
{
  "schemaVersion": 1,
  "hostname": "openscale_a1b2c3",
  "redirectToHostname": true,
  "http_indexpath": "/default.html",
  "buffer": {
    "ringbuffer_max_total_size_bytes": 262144,
    "queue_capacity": 64
  },
  "https": { "enabled": false },
  "security": { "passwordSet": true }
}
```

Fields:

| Field | Meaning |
|---|---|
| `schemaVersion` | Configuration schema version; currently 1 |
| `hostname` | Device hostname without `.local`; generated on first boot if empty using `openscale_` plus the final three base-MAC bytes in hex |
| `redirectToHostname` | Redirect requests addressed by IP to the mDNS hostname when resolvable |
| `http_indexpath` | Static asset served for `/`; default `/default.html` |
| `buffer.ringbuffer_max_total_size_bytes` | Aggregate memory budget for all per-sensor ring buffers |
| `buffer.queue_capacity` | Shared acquisition queue capacity |
| `https.enabled` | HTTPS request; reject true while TLS is unavailable/not operational. HTTP itself cannot be disabled |
| `security.passwordSet` | GET-only indicator; true if an administrator password exists |

### 3.2 Administrator password handling

The write-only API input is `security.password` (the API GET view reports `security.passwordSet` instead):

- Omitted on PUT: retain the existing administrator password.
- String value: set or replace the password.
- `null`: remove the password.

GET removes `security.password` entirely and returns only `security.passwordSet: true|false`. `passwordSet` is read-only and is ignored as input on PUT; only `security.password` changes the secret. The on-device file stores a salted PBKDF2-HMAC-SHA256 verifier, never the plaintext password. ESP decision: the verifier is stored as an internal `security.passwordVerifier` object containing algorithm, salt, iteration count and verifier bytes; exact iteration count is selected by firmware benchmarking. The API-facing representation is not a byte-for-byte dump of the internal verifier fields.

Factory defaults include no administrator password, `https.enabled: false`, and `/default.html` as the index path; the hostname is generated and saved only on first successful initialisation (not as a repair of a corrupt file). If `settings.json` cannot be loaded at startup, use in-memory factory defaults without altering the saved file and log the fallback. If the fallback contains no admin password, access is limited by the fallback WPA2 AP credential; set an administrator password after recovery.

## 4. `wifi.json` — Wi-Fi networks and AP

### 4.1 Example GET representation

```json
{
  "schemaVersion": 1,
  "networks": [
    { "id": 1, "ssid": "Home", "passwordSet": true, "priority": 100 },
    { "id": 2, "ssid": "Workshop", "passwordSet": true, "priority": 80 }
  ],
  "ap": {
    "enabled": true,
    "ssidPrefix": "OpenScale",
    "channel": 1,
    "maxStations": 4,
    "keepApWhenConnected": false,
    "passwordSet": true
  }
}
```

### 4.2 Rules

- Each station network has a stable numeric `id`, distinct from SSID. Priority is descending; equal priorities retain array order.
- PUT submits the complete network list. Existing entries are matched by ID; entries with no ID are new and receive an ESP-assigned stable ID; an existing ID omitted from the submitted list is deleted.
- For a network password: omitted means retain the password for that ID; string sets/replaces it; null clears it. GET never returns `password`, only `passwordSet`. The read-only `passwordSet` indicator is ignored on PUT; `password` is the only secret input.
- AP `password` follows the same GET-redaction/PUT semantics; its read-only `passwordSet` indicator is ignored on PUT. Factory AP credentials are generated per device and printed to the serial console; do not return them in JSON.
- `keepApWhenConnected` defaults false. A fallback AP starts when station connection attempts fail; stop it after successful STA connection unless configured to remain active.
- AP+STA operation is supported where the chip/driver allows it; the interfaces share one radio/channel.

Factory default is an empty `networks` list with the fallback AP enabled, SSID prefix `OpenScale`, channel 1, four client slots and `keepApWhenConnected:false`; its SSID is `<ssidPrefix>-<last-two-MAC-bytes>`, and its password is generated per device and printed to serial. ESP startup decision: try networks in descending priority order, with original array order for ties; allow 15 seconds per candidate; retry a complete pass every 30 seconds if no STA connection is established. Start the fallback AP when no saved network connects.

If `wifi.json` cannot be loaded at startup, use in-memory factory defaults without modifying the saved file and log a `config_fallback` entry.

## 5. `sensors.json` — all sensor definitions

One document contains all sensor instances. Factory default is `{"schemaVersion":1,"sensors":[]}` (no board-specific GPIO assumptions). ESP-owned fields are interpreted by firmware. WebUI-owned fields are stored and preserved but not interpreted. The example combines an HX711 load cell with an auxiliary temperature channel.

```json
{
  "schemaVersion": 1,
  "sensors": [
    {
      "id": 0,
      "name": "Scale 1",
      "notes": "bench 2",
      "kind": "loadcell",
      "type": "hx711",
      "enabled": true,
      "unit": "ADC count",
      "rawFormat": "int24",
      "rate_hz": 80,
      "ringbuffer_size_samples": 1600,
      "hx711": {
        "dout_gpio": 16,
        "sck_gpio": 4,
        "rate_gpio": null,
        "gain": null
      },
      "warnings": {
        "overload": {
          "enabled": true,
          "threshold": 8388607,
          "hysteresis": 1024
        },
        "underload": {
          "enabled": true,
          "threshold": -8388608,
          "hysteresis": 1024
        }
      },
      "calibrationFile": "calibration_0_my-profile.json",
      "primaryTemperatureSensorId": 1,
      "loadLimits": {
        "maxLoad": { "value": 200, "unit": "g" },
        "minLoad": null,
        "averageS": 0.1,
        "yellowPercent": 10,
        "orangePercent": 20,
        "redPercent": 40,
        "breakS": 0.5,
        "holdS": 8
      }
    },
    {
      "id": 1,
      "name": "Load cell body",
      "kind": "temperature",
      "type": "temperature",
      "enabled": true,
      "unit": "m°C",
      "rawFormat": "int32",
      "rate_hz": 1,
      "ringbuffer_size_samples": 1000,
      "attachedTo": [0],
      "conversion": { "type": "direct", "rawScale": 0.001, "unit": "°C" }
    }
  ]
}
```

### 5.1 Field ownership and meaning

| Key | Owner | Meaning |
|---|---|---|
| `id` | ESP | Unique numeric sensor ID |
| `name` | ESP | Display name; editable by WebUI |
| `notes` | WebUI | Free text |
| `kind` | WebUI | `loadcell` (default), `temperature` or `generic`; tells WebUI how to present/use the channel |
| `type` | ESP | Hardware/driver type (`hx711`, `temperature`, etc.) |
| `enabled` | ESP | Whether the sensor is active |
| `unit` | ESP | Unit/meaning of the raw value, e.g. `ADC count`, `m°C`, `mΩ` |
| `rawFormat` | ESP | Native value encoding in uint64 `raw`; see §5.2 |
| `rate_hz` | ESP | Required nominal/effective sampling rate for every sensor; HX711 allows 10 or 80 |
| `ringbuffer_size_samples` | ESP | Retained sample capacity for this sensor |
| driver block (`hx711`, etc.) | ESP | Driver configuration |
| `warnings` | ESP | Raw overload/underload thresholds and hysteresis |
| `attachedTo` | WebUI | Numeric load-cell IDs to which an auxiliary channel belongs |
| `conversion` | WebUI | Browser conversion from decoded `raw` into physical value; opaque to ESP |
| `calibrationFile` | WebUI | Active calibration filename for a load cell, or null |
| `primaryTemperatureSensorId` | WebUI | Temperature channel used for uncertainty estimate, or null |
| `loadLimits` | WebUI | Browser-side calibrated-weight warning monitor; ESP stores and ignores it |

No separate `sensor_settings.json` or `webui-sensor-settings.json` exists; their required content is merged here or omitted.

### 5.2 `rawFormat` and uint64 transport

`raw` is always an unsigned 64-bit integer on JSON/SSE and binary transports. The uint64 contains the native value's bit pattern, zero-extended where the native width is less than 64 bits:

| `rawFormat` | Native value | uint64 content |
|---|---|---|
| `uint32` | unsigned 32-bit | value in bits 0–31; upper bits zero |
| `uint64` | unsigned 64-bit | value |
| `int24` | signed 24-bit (HX711) | two's-complement bits 0–23; upper bits zero |
| `int32` | signed 32-bit | two's-complement bits 0–31; upper bits zero |
| `int64` | signed 64-bit | full 64-bit two's-complement pattern |
| `float32` | IEEE-754 single | 32-bit IEEE-754 pattern in bits 0–31; upper bits zero |
| `float64` | IEEE-754 double | full 64-bit IEEE-754 pattern |

The WebUI decodes the bit pattern according to `rawFormat`. It must not first coerce all uint64 JSON tokens to JavaScript `Number`; values above 2^53−1 require lossless parsing. No sensor-specific binary-history layout is used.

### 5.3 `warnings` — raw hardware thresholds

At most two firmware warning thresholds are defined: `overload` and `underload`. Each has `enabled`, `threshold` and non-negative `hysteresis`. Threshold and hysteresis are expressed in the sensor's native raw numeric domain described by `rawFormat` (not the unsigned transport integer). For signed formats, thresholds may be negative. For floating-point formats, values are numeric and must be finite.

Hysteresis rules:

- Overload activates when native value `>= threshold`; it clears when value `<= threshold - hysteresis`.
- Underload activates when native value `<= threshold`; it clears when value `>= threshold + hysteresis`.

`hysteresis` is required when the warning is enabled; it may be zero for an intentionally non-hysteretic threshold. Warning flags are computed on demand and are not retained in the ring buffer.

### 5.4 `conversion` — WebUI-defined, opaque to ESP

Example:

```json
{ "type": "polynomial", "coefficients": [-12.3, 0.0042], "rawScale": 1, "unit": "°C" }
```

Let `x = decodedRaw × rawScale`, with `rawScale` defaulting to 1.

| `type` | Parameters | Definition |
|---|---|---|
| `direct` | none | `y = x` |
| `polynomial` | `coefficients: [c0,c1,…]` | `y = c0 + c1·x + c2·x² + …` |
| `steinhart-hart` | `a`, `b`, `c` | `x` is resistance in Ω; `1/T = a + b·ln(x) + c·ln(x)^3`; `T` in K; `y = T − 273.15` °C |
| `beta` | `beta`, `r0`, `t0` °C, optional `rSeries` | `R = x − rSeries`; `1/T = 1/(t0+273.15) + ln(R/r0)/beta`; `y = T − 273.15` °C |

ESP decision: `rSeries` is a series resistance included in the measured total resistance and is subtracted to obtain the thermistor resistance. Omitted `rSeries` defaults to zero. Invalid/non-positive resistance or a non-finite conversion result is an invalid converted sample; the WebUI must not substitute zero. Temperature conversion output unit is `°C`.

The ESP stores this object without interpretation. Additional conversion `type` values can be added by the WebUI without firmware schema changes.

### 5.5 `loadLimits` — browser-side calibrated-mass monitor

| Key | Meaning | Default |
|---|---|---|
| `maxLoad` `{value, unit}` | Upper weight limit; unit is an ID from `units.json`; null/missing disables monitor | off |
| `minLoad` `{value, unit}` or null | Lower weight limit; null means `−maxLoad` | null |
| `averageS` | Averaging interval of newest samples, seconds | 0.1 |
| `yellowPercent`, `orangePercent`, `redPercent` | Excess above limit triggering each level (rising) | 10, 20, 40 |
| `breakS` | Gaps shorter than this remain one event, seconds | 0.5 |
| `holdS` | Warning display hold duration, seconds | 8 |

These are evaluated in the browser and are independent of ESP raw `warnings`. The WebUI also displays firmware `warning` events.

### 5.6 Configuration change handling

WebUI-owned fields and presentation metadata (`notes`, `kind`, `conversion`, `loadLimits`, `calibrationFile`, `primaryTemperatureSensorId`) are stored without touching sensor drivers. Changes to `type`, `rawFormat`, `rate_hz`, driver blocks, raw warning thresholds/hysteresis and `ringbuffer_size_samples` require the corresponding runtime application/reconfiguration. The ESP reports the effect in the PUT response and `/api/status.pendingChanges`.

Revision handling is separate from the write classification:

- `configRevision` (**Explicit**) increments only when an actual effective configuration value changes and can alter sample interpretation or continuity: `type`, `rawFormat`, effective `rate_hz`, driver measurement configuration affecting raw measurements, or an explicit buffer clear. It starts at 1 per sensor per boot. A `buffer=preserve` resize does not increment it unless continuity is also cleared/restarted.
- `warningRevision` (**Explicit**) increments only when active warning enablement, overload/underload thresholds or hysteresis actually changes. It starts at 1 per sensor per boot. A warning-only change never increments `configRevision` and never starts a new WebUI sample buffer.

Ring-buffer resize mode is `?buffer=preserve|clear` on the `sensors.json` PUT; default is `preserve`.

## 6. `units.json` — WebUI-owned unit table

The ESP validates structure only: JSON object, `schemaVersion`, `baseUnit`, `defaultUnit` and `units` array. It does not interpret the physical conversion table.

```json
{
  "schemaVersion": 1,
  "baseUnit": "mg",
  "defaultUnit": "g",
  "units": [
    {"id":"ug","name":"Micrograms","symbol":"µg","factor":0.001,"decimals":0,"group":"Metric"},
    {"id":"mg","name":"Milligrams","symbol":"mg","factor":1,"decimals":1,"group":"Metric"},
    {"id":"g","name":"Grams","symbol":"g","factor":1000,"decimals":3,"group":"Metric"},
    {"id":"kg","name":"Kilograms","symbol":"kg","factor":1000000,"decimals":3,"group":"Metric"},
    {"id":"oz_av","name":"Ounces (avoirdupois)","symbol":"oz","factor":28349.523125,"decimals":4,"group":"Imperial / US customary"},
    {"id":"lb_av","name":"Pounds (avoirdupois)","symbol":"lb","factor":453592.37,"decimals":5,"group":"Imperial / US customary"},
    {"id":"oz_troy","name":"Troy ounces","symbol":"oz t","factor":31103.4768,"decimals":4,"group":"Imperial / US customary"},
    {"id":"st","name":"Stone","symbol":"st","factor":6350293.18,"decimals":4,"group":"Imperial / US customary"},
    {"id":"raw","name":"Raw sensor counts (diagnostic)","symbol":"counts","factor":null,"decimals":0,"group":"Diagnostic"}
  ]
}
```

`factor` converts the canonical unit (milligram) to the display unit: `value in unit = mg / factor`. `factor: null` marks the non-physical raw entry. This table is the factory default; DELETE restores it. The WebUI embeds the same table as fallback.

## 7. `webui-settings.json` — WebUI-owned preferences

The ESP stores and serves this file without interpreting it. Every persisted JSON file still needs `schemaVersion: 1`; therefore the factory default is `{"schemaVersion":1}` (not a bare `{}`). Missing preference keys use WebUI built-in defaults.

Example with explicit preferences:

```json
{
  "schemaVersion": 1,
  "theme": "dark",
  "navPanelVisible": false,
  "yResponsePercent": 5,
  "downsample": false,
  "zeroFill": false,
  "zeroRawFill": false,
  "zeroLine": false,
  "wizardMode": "simple",
  "bandMode": "symmetric",
  "subPixel": false,
  "tempRateWindowS": 60
}
```

Tare state, time since tare and the typical-use assumptions for uncertainty estimation (reading delay, session since tare, temperature difference) are browser-session state and are not stored in this file. The selected index asset is `settings.json.http_indexpath`, not a WebUI preference. To reduce flash wear, WebUI should save this file only when necessary and avoid frequent writes. Unknown keys are preserved by the ESP; the WebUI may ignore keys it does not understand.

## 8. Calibration files — WebUI-owned gzip resources

### 8.1 Path and identity

```text
/data/calibration/calibration_<sensorId>_<profileId>.json
```

- `<sensorId>` is a decimal numeric sensor ID.
- `<profileId>` matches `[A-Za-z0-9._-]+`.
- The document also contains the same numeric `sensorId` and `profileId`; filename and document must agree.
- Multiple profiles per sensor are allowed.
- `sensors.json.calibrationFile` holds the filename of the active calibration; it may be null. Temporary profile selection may remain in browser state without writing `sensors.json`.

### 8.2 Compression and handling

Upload with `Content-Type: application/json` and `Content-Encoding: gzip`; the ESP stores the received bytes unchanged and serves them with `Content-Encoding: gzip`. The ESP does not decompress or validate the contents in this version. Calibration files are non-essential; accept/store them whenever flash space permits. PUT and DELETE require password authentication when a password is set; GET is public. `/api/files` reports stored compressed size.

### 8.3 Schema ownership

The WebUI owns the schema; the ESP treats the file as an opaque gzip blob. Expected top-level keys include:

`schemaVersion`, `sensorId`, `profileId`, `profileName`, `createdAt`, `modifiedAt`, `applicationVersion`, `calibrationUnit`, `calibrationMethod`, `sensor`, `environment`, `referenceWeights`, `referenceWeightGroups`, `referenceLoads`, `observations`, `calibrationAnchors`, `fit`, `uncertainty`, `characterization`, `validation`, `reserved`, `revisionId`, `contentHash`.

Minimal illustrative header (not a full calibration profile):

```json
{
  "schemaVersion": 1,
  "sensorId": 0,
  "profileId": "my-profile",
  "profileName": "Bench calibration"
}
```

The uncompressed WebUI JSON may be roughly 30–250 KiB; compressed upload size is expected to be much smaller. The ESP enforces a maximum request body (`maxUploadBytes`) and actual filesystem capacity. Return 413 for the configured request-size limit and 507 when storage space is insufficient.

## 9. Future WebUI data resources

`checkweighings.json` is a future long-term drift log; its format exists in the WebUI but it is not part of the current API implementation. Proposed path: `/data/user/checkweighings.json`. Future WebUI-owned user-data files should be gzip-compressed like calibration blobs. Do not implement a generic `/data/user/` API until a concrete resource and lifecycle are agreed.

## 10. JSON exchange payload notes

Successful calibration-file and static-asset PUT requests return the common write-response JSON:

```json
{
  "status": "applied",
  "saved": true,
  "errors": [],
  "warnings": [],
  "pendingChanges": []
}
```

For these uploads, `applied` means stored and immediately retrievable at the same resource URL. They do not increment `configRevision` or `warningRevision`. The calibration file remains an opaque gzip blob to the ESP; the response does not imply calibration parsing or application. A successful static-asset PUT makes the new gzip asset available at its path. Storage failures use the protocol's HTTP error responses (including 507 when flash capacity is insufficient).

History samples use `sensorId`, `n`, `t`, `raw` and optional `flags`. `raw` and all 64-bit fields are unsigned integer tokens on the wire. Warning event JSON adds `type:"sensor"`, `code`, `active` and a nested `sensor` object containing `sensorId`, `threshold` and `sample`; see `api-protocol_v0.5.md` for complete SSE payloads.

A JSON `flags` value is u32; absent means zero. The same bit meanings apply as in binary history. Threshold flags are computed on demand; they are not retained in ring buffers. Historical bits for sensor disconnection/error/invalid measurement cannot be reconstructed unless future firmware stores additional metadata; device log/events provide those historical transitions.
