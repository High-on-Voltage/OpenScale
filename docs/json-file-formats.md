# OpenScale ESP32 — JSON File Formats and Examples

**Document purpose:** Configuration-file and JSON exchange-format reference  
**Version:** 0.2

## 1. General rules

- Configuration and calibration files are JSON and are stored uncompressed on flash.
- Static WebUI assets are a separate class: they are stored and served as gzip, not as ordinary JSON configuration files.
- Settings are separated by responsibility. `wifi.json` was introduced to separate network configuration from system settings.
- `/data` is a protected namespace. Generic static-file handling must not write into `/data`.
- Critical configuration is validated before replacement. A failed check must not replace the working critical configuration. Use temporary-file replacement/transactional update where supported.
- Calibration files are non-essential: save and serve them even if validation reports a problem, and report that problem to the WebUI.
- Exact final schemas were not completed in the requirements. Examples below use fields and naming already proposed there; they are working examples, not a frozen JSON Schema.

### Acceptance-status words

- **Explicit** — directly confirmed by the user.
- **Implicit** — proposed in the requirements and not rejected, or included in a general agreement.
- **Open** — exact structure or field name was not settled.

## 2. Files and paths

| File / path | Purpose | Firmware handling | Status |
|---|---|---|---|
| `/data/settings/settings.json` | System-wide settings, security, memory limits, hostname, HTTP index path | Parse and validate; critical | Explicit |
| `/data/settings/wifi.json` | Saved Wi-Fi networks, priorities and AP settings | Parse and validate; protect credentials | Implicit |
| `/data/settings/sensors.json` | Numeric sensor IDs, types, GPIO/driver settings, buffers and warning thresholds | Parse and validate; check driver/GPIO and total memory budget | Explicit |
| `/data/settings/units.json` | Unit definitions/metadata used by the system and WebUI | Store and serve as JSON; validate on write | Explicit |
| `/data/settings/webui-settings.json` | WebUI-owned settings | Store/serve; firmware does not interpret it | Explicit |
| `/data/calibration/<name>.json` | Calibration documents; multiple files allowed | Store/serve even when a check fails; report validation result | Explicit |
| `/<web-path>` (stored as gzip on flash) | Static HTML, JavaScript, CSS and other web assets | Store compressed and serve with `Content-Encoding: gzip` | Explicit |

The user requested full `.json` filenames for configuration PUT paths and specifically the name `webui-settings.json`. The exact config PUT URL prefix was not settled; see the protocol document.

## 3. `settings.json`

### 3.1 Responsibility

System-wide settings belong here, including security, memory limits, hostname, HTTP/HTTPS redirect behaviour and the selected index asset. HTTP itself cannot be disabled. Wi-Fi network credentials are separated into `wifi.json`.

The user explicitly selected a single `http_indexpath` entry in `settings.json` rather than a separate index API. Its default is `/default.html`.

The hostname is generated on first initialisation if empty, using `openscale_` plus the last three bytes of the base MAC address in hexadecimal. It is saved and can later be changed. `redirectToHostname` controls the HTTP redirect to the mDNS hostname.

### 3.2 Illustrative JSON

```json
{
  "hostname": "openscale_a1b2c3",
  "redirectToHostname": true,
  "http_indexpath": "/default.html",
  "storage": {
    "ringbuffer_max_total_size_bytes": 262144
  },
  "https": {
    "enabled": false
  }
}
```

Field notes:

| Field | Meaning | Status |
|---|---|---|
| `hostname` | Saved device hostname without `.local` | Implicit |
| `redirectToHostname` | Redirect IP-address HTTP requests to the hostname when possible | Implicit |
| `http_indexpath` | Asset served for a request to `/`; default `/default.html` | Explicit |
| `storage.ringbuffer_max_total_size_bytes` | Aggregate ring-buffer memory budget | Implicit; field name specified for the configuration |
| `queue_capacity` | Bounded acquisition-queue capacity | Implicit; exact placement in the settings schema is open |
| `https.enabled` | Reserved HTTPS switch; HTTPS remains deferred and must not be treated as implemented | Implicit |

The exact HTTPS configuration field structure and the complete security/password field structure were not finalised. If HTTPS is enabled and fully functional, HTTP redirects to HTTPS; otherwise HTTP remains available. The administrator password should not be stored as plaintext; the administrator password is stored as a salted PBKDF2-HMAC-SHA256 verifier. HTTP Basic credentials remain exposed on an unencrypted HTTP connection until HTTPS is implemented.

If `settings.json` cannot be loaded at startup, in-memory defaults are used without overwriting the saved file, and a device network-log entry is generated. The per-boot CSRF token is ephemeral runtime state, not a persistent setting; it must not be saved in this file.

## 4. `wifi.json`

### 4.1 Responsibility

This file contains multiple saved station networks, their user-defined order/priority and access-point settings. The ESP tries networks by priority and availability. If no saved network can be reached, it enables its fallback AP. AP+STA operation was accepted as a supported capability; both interfaces share one Wi-Fi radio and channel.

Wi-Fi passwords must be stored in a form the ESP can recover for reconnection. Ordinary configuration GET responses must not disclose them in plaintext. `wifi.json` GET and PUT require administrator password protection when a password is configured.

### 4.2 Illustrative JSON

```json
{
  "networks": [
    {
      "ssid": "Home",
      "password": "replace-with-secret",
      "priority": 100
    },
    {
      "ssid": "Workshop",
      "password": "replace-with-secret",
      "priority": 80
    },
    {
      "ssid": "Mobile hotspot",
      "password": "replace-with-secret",
      "priority": 20
    }
  ]
}
```

`priority` is an ordering value; higher numbers in the example are tried first. The exact tie-breaking policy, AP configuration object, retry intervals, connection timeouts and whether the AP remains active after a successful station connection remain open. If `wifi.json` cannot be loaded at startup, in-memory defaults are used without overwriting the saved file, and a device network-log entry is generated.

## 5. `sensors.json`

### 5.1 Responsibility

This file defines sensor instances. IDs are numerical and unique. The schema is generic: HX711 is the initial driver, but other supported sensor types use the same common sensor model and data pipeline.

Every sensor has its own driver instance, sample counter, ring buffer, status and optional warning thresholds. The sensor definition should describe the meaning and unit of `raw`; the WebUI is responsible for presentation.

### 5.2 Illustrative JSON

```json
{
  "sensors": [
    {
      "id": 0,
      "name": "Scale 1",
      "type": "hx711",
      "enabled": true,
      "unit": "ADC count",
      "rawFormat": "uint64",
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
          "threshold": 8388607
        },
        "underload": {
          "enabled": true,
          "threshold": -8388608
        }
      }
    },
    {
      "id": 1,
      "name": "Temperature",
      "type": "temperature",
      "enabled": false,
      "unit": "m°C",
      "rawFormat": "uint64",
      "ringbuffer_size_samples": 1000
    }
  ]
}
```

This is a composite example, not a complete driver schema. `unit`, `rawFormat`, generic `warnings` and the `temperature` driver are illustrative extensions discussed in the requirements; the actual temperature driver's configuration is not specified.

### 5.3 HX711 fields

| Field | Meaning / constraint |
|---|---|
| `id` | Unique numerical sensor ID |
| `type` | `hx711` for this driver |
| `enabled` | Whether this sensor is active |
| `rate_hz` | `10` or `80`; converter rate is selected by the RATE pin |
| `ringbuffer_size_samples` | Configured number of retained samples for this sensor |
| `hx711.dout_gpio` | HX711 data-ready/data output GPIO |
| `hx711.sck_gpio` | HX711 clock GPIO |
| `hx711.rate_gpio` | Optional GPIO driving RATE; when `null`, RATE must be physically strapped to the configured rate |
| `hx711.gain` | `A128`, `A64`, `B32` or `null` |

The initial implementation snapshot's initial example uses sensor ID `0`, DOUT GPIO `16` and SCK GPIO `4`; this is a starting board configuration only. Sensor IDs `1` and `2` in that scaffold were disabled because their pin assignments were unknown.

The HX711 raw value originates as a signed 24-bit ADC reading. The common protocol transports the raw field as unsigned 64-bit; the encoding/mapping of negative HX711 values must be defined consistently (Open). The initial driver implementation does not apply calibration, offset, scale conversion or filtering.

### 5.4 Warning configuration

Overload and underload are optional raw-value comparisons. The illustrative structure uses `enabled` and `threshold` for each warning. Hysteresis was accepted: activation and clear conditions must be different so the warning does not chatter around a single threshold. Exact property names and the hysteresis representation were not agreed.

The numerical thresholds in the example above are illustrative only, not recommended HX711 operating thresholds.

### 5.5 Ring-buffer sizing

`ringbuffer_size_samples` is per sensor. At allocation time, the firmware checks the sum of the per-sensor buffer allocations against the configured aggregate budget. Memory should be allocated as large as reasonably possible without starving stacks, networking and other essential allocations. PSRAM is optional and may be used to increase capacity.

Runtime resizing without a device restart is required, with both behaviours:

- `preserve`: keep/copy the newest samples that fit.
- `clear`: release the existing buffer first, then allocate the new capacity to maximise memory availability; history is lost. If the new allocation fails, report it and attempt recovery where possible.

The API field that selects the mode remains open.

## 6. `units.json`

Path: `/data/settings/units.json`. This JSON resource is user-accessible through the data API. GET is available without an administrator password; PUT requires administrator password protection when a password is configured. The exact schema and sample unit definitions remain open.

Illustrative placeholder:

```json
{
  "units": []
}
```

## 7. `webui-settings.json`

This file belongs to the WebUI. The firmware stores and serves it, but must not interpret its contents. The exact schema is owned by the WebUI project and is not defined here.

Minimal valid placeholder:

```json
{}
```

The selected HTTP index path is **not** stored here; it is `http_indexpath` in `settings.json`.

## 8. Calibration JSON files

Any number of calibration JSON files may be stored under `/data/calibration/`. There is no one-file-per-sensor restriction. The document itself identifies the sensor to which it belongs; the URL does not contain a sensor ID. No active-calibration selection field or final calibration schema was specified.

Illustrative minimal association example:

```json
{
  "sensorId": 0
}
```

`sensorId` is the proposed field spelling based on the sensor ID naming used elsewhere; the sensor association is required, but the exact property name and calibration payload schema remain open. Do not interpret the example as a complete calibration document.

Calibration documents are non-essential. If validation fails, the ESP still stores and serves the submitted JSON and reports the failed check to the WebUI. PUT requires administrator password protection when a password is configured; GET and DELETE do not.

## 8. JSON exchange payloads

The following JSON structures were proposed for HTTP/SSE exchange. The protocol document records the associated URL and unresolved negotiation points.

### 8.1 History response

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

- `sensorId`: numerical sensor ID.
- `n`: per-sensor sample ID.
- `t`: monotonic microseconds since boot.
- `raw`: unsigned raw measurement value.
- `latestId`: latest sample ID currently known for this sensor; useful for pagination/truncation detection. It is not needed in SSE.

The example is per-sensor. Whether the final history API returns one sensor or multiple sensors in one response was not conclusively settled.

### 8.2 SSE event payloads

SSE frames use the global `id:` field and an event name; the JSON `data` payload for a sample is:

```text
id: <bootId>-<eventCounter>
event: sample
data: {"sensorId":0,"n":501,"t":123456789,"raw":12345}
```

The `id:` line of the SSE frame is a separate, device-global event ID of the form `<bootId>-<eventCounter>`. The event ID is not the sensor sample ID.

### 8.2.2 Warning event candidate

```json
{
  "sensorId": 0,
  "type": "overload",
  "active": true,
  "threshold": 8388607,
  "raw": 9000000,
  "n": 501,
  "t": 123456789
}
```

When the condition clears, emit the same event type with `active: false`. The event is sent on state transition. The warning event includes the same sample context fields as the sample event (`sensorId`, `n`, `t`, `raw`) plus warning-specific fields. The precise inactive-event payload remains open.

Threshold-derived warning flags are generated on-the-fly and are not stored in ring buffers to avoid increasing RAM use. Sensor quality/status flags include at least disconnection, sensor error, overload, underload, invalid measurement and future quality indicators; bit assignments and persistence of non-threshold flags remain open.

### 8.3 Device metadata candidate

```json
{
  "product": "OpenScale",
  "firmwareVersion": "0.1.0",
  "firmwareBuild": "development",
  "gitCommit": "abcdef123456",
  "idfVersion": "6.1",
  "chip": "ESP32-S3",
  "revision": 0,
  "psram": true,
  "capabilities": {
    "sse": true,
    "historyJson": true,
    "historyBinary": true,
    "wifiApSta": true,
    "https": false,
    "ota": false
  }
}
```

This is an illustrative example, not a final field list. Later discussion explicitly requested as much hardware/memory information as practical, including PSRAM size/type and flash size/type, physical flash capacity, filesystem/partition used/free space, chip revision and core count, plus supported features and protocol versions.

### 8.4 Runtime status candidate

A representative shape using the agreed information categories is:

```json
{
  "bootId": "a83f21c9",
  "uptimeUs": 123456789012,
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
  "wifi": {
    "connected": true,
    "rssi": -55,
    "ip": "192.168.1.50"
  },
  "sensors": [
    {
      "sensorId": 0,
      "ringBufferCapacity": 1600,
      "ringBufferUsed": 1200,
      "queueDrops": 0,
      "readErrors": 0
    }
  ]
}
```

This example is structural only. Exact property names, units, nullability and completeness were not specified. Physical flash capacity must be reported separately from free filesystem space; they are not interchangeable. A per-boot CSRF token is expected to be delivered through the initial authenticated device/status exchange, but its JSON field name remains open.

## 9. Binary-history reference

The binary format is described here because it carries the same logical sample fields as the JSON history response. It is **not JSON**.

| Field | Size | Type / meaning |
|---|---:|---|
| Magic `HIST` | 4 bytes | Fixed ASCII signature (`48 49 53 54`) |
| Version | 2 bytes | Unsigned 16-bit format version; value `1` |
| Header flags | 2 bytes | Unsigned 16-bit; intended for future options, bit assignments open |
| Sample count | 4 bytes | Unsigned 32-bit count of records in this response |
| `n` | 8 bytes | Unsigned 64-bit per-sensor sample ID |
| `t` | 8 bytes | Unsigned 64-bit timestamp, microseconds since boot |
| `raw` | 8 bytes | Unsigned 64-bit raw value |
| Sample flags | 4 bytes | 32-bit sensor quality/status flags; bit assignments open |

All multi-byte fields are little-endian. The sample record is therefore 28 bytes.

**Header size:** the fields total 12 bytes (`4 + 2 + 2 + 4`). No additional bytes are present or required. The expected payload length is:

```text
12 + (sampleCount × 28)
```

The format version is `1`. Header flags remain reserved for future use. Sample flags cover at least sensor disconnection, sensor error, overload, underload, invalid measurement and future quality indicators. Threshold-derived overload/underload warning flags are generated on-the-fly and are not saved in the ring buffer; therefore they must not be represented as persisted ring-buffer flags. If a binary history response includes these calculated flags, the firmware must derive them during response generation.
