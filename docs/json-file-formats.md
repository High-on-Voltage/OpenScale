# OpenScale: JSON File Formats (v0.3, merged WebUI + ESP proposal)

**Purpose:** merge of `json-file-formats_v0_2.md` (ESP side) with the formats the WebUI already implements.
**For:** ESP AI worker (check, re-discuss, incorporate into the working documents).
**Companion:** `api-protocol_v0_3.md` (routes, headers, SSE, history, auth).

Status tags: **[Agreed]** settled between user and WebUI side. **[Proposal]** WebUI requirement, ESP to confirm. **[ESP]** decided by the ESP side. **[Open]** unresolved.

---

## 1. General rules

- **[Agreed]** Every JSON file carries `"schemaVersion": 1` (integer) as a top-level key. Additive changes keep version 1.
- **[Agreed]** Sensor IDs are **numeric** everywhere (JSON number, e.g. `0`). The WebUI converts them to strings internally.
- **[Agreed]** Unknown keys must be **preserved** by the ESP when it re-saves a file (the WebUI adds keys the firmware does not know).
- **[Agreed]** Settings files are stored uncompressed (ESP v0.2 rule). **Calibration files (and future similar WebUI data files) are sent, stored and served gzip-compressed** (see §9).
- **[Agreed]** `PUT` replaces the whole file. There is **no `PATCH`**. The ESP compares the new content with the active one itself (e.g. changed GPIOs) and decides what needs reconfiguration. The WebUI does GET, modify, PUT of the complete document.
- **[Agreed]** `DELETE /data/settings/<name>.json` **resets that file to its factory default**. A following `GET` returns the default content (HTTP 200, not 404).
- **[Agreed]** Critical files are validated before replacement; a failed check must not replace the working configuration (ESP v0.2). Calibration/WebUI files are non-essential.
- **[Agreed]** Config URLs: GET, PUT and DELETE use the **same** URL `/data/settings/<name>.json` (the `/api/config/` prefix is dropped).
- **[Agreed]** Free flash space is decided and reported by the ESP; if something cannot be stored the ESP returns **HTTP 507** with an explanatory body. The WebUI shows that body to the user. The ESP decides all maximum file sizes.

## 2. Files and ownership

| File | Owner of the schema | ESP interprets? | Password (when set) |
|---|---|---|---|
| `/data/settings/settings.json` | ESP | yes | GET, PUT, DELETE |
| `/data/settings/wifi.json` | ESP | yes | GET, PUT, DELETE |
| `/data/settings/sensors.json` | ESP (driver part) + WebUI (marked keys) | partly (see §5) | PUT, DELETE |
| `/data/settings/units.json` | WebUI | structure only | PUT, DELETE |
| `/data/settings/webui-settings.json` | WebUI | no, stores and serves | PUT, DELETE |
| `/data/calibration/<name>.json` | WebUI | no, stores and serves (gzip) | PUT |

`sensor_settings.json` / `webui-sensor-settings.json` do **not** exist any more; their content is merged into `sensors.json` or dropped (§5, §8).

## 3. `settings.json` [ESP]

As in v0.2, plus `schemaVersion`. The WebUI only reads and edits what the ESP defines.

```json
{
  "schemaVersion": 1,
  "hostname": "openscale_a1b2c3",
  "redirectToHostname": true,
  "http_indexpath": "/default.html",
  "storage": { "ringbuffer_max_total_size_bytes": 262144 },
  "https": { "enabled": false },
  "security": { "passwordSet": true }
}
```

**Secrets (applies to `settings.json` and `wifi.json`) [Agreed]:**

- **GET:** the ESP strips every password and adds `"passwordSet": true` (a password exists but is not returned) or `"passwordSet": false` (none).
- **PUT:** `password` omitted = keep the existing one. `"password": "new-secret"` = set or replace. `"password": null` = remove.
- The administrator password follows the same pattern (exact object path is the ESP's choice, e.g. `security.password` / `security.passwordSet`). It is stored as PBKDF2 verifier, never returned.
- The ESP merges the PUT with the stored file on its side.

## 4. `wifi.json` [ESP]

```json
{
  "schemaVersion": 1,
  "networks": [
    { "id": 1, "ssid": "Home", "passwordSet": true, "priority": 100 },
    { "id": 2, "ssid": "Workshop", "passwordSet": true, "priority": 80 }
  ]
}
```

- **[Agreed]** Every network gets a **stable `id`** (in addition to the SSID).
- **[Agreed]** GET never returns `password`; PUT semantics as in §3.
- **[Proposal]** The WebUI sends the complete list. Entries are matched by `id`; an entry without `id` is new; an `id` missing from the list means deleted. ESP to confirm or define.
- **[ESP-only note]** Use atomic replacement for the file (write `wifi.json.tmp`, replace after the flash write finished).
- **[Open]** AP object, retry intervals, timeouts, tie-breaking (unchanged from v0.2).

## 5. `sensors.json` (merged)

One document for all sensors (load cells and auxiliary channels such as temperature). Keys are either **ESP** (interpreted by the firmware) or **WebUI** (stored, preserved, not interpreted; the ESP may use them in future).

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
      "hx711": { "dout_gpio": 16, "sck_gpio": 4, "rate_gpio": null, "gain": null },
      "warnings": {
        "overload":  { "enabled": true, "threshold": 8388607 },
        "underload": { "enabled": true, "threshold": -8388608 }
      },
      "calibrationFile": "calibration_0_my-profile.json",
      "primaryTemperatureSensorId": 1,
      "loadLimits": {
        "maxLoad": { "value": 200, "unit": "g" },
        "minLoad": null,
        "averageS": 0.1,
        "yellowPercent": 10, "orangePercent": 20, "redPercent": 40,
        "breakS": 0.5, "holdS": 8
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

### 5.1 Fields

| Key | Owner | Meaning |
|---|---|---|
| `id` | ESP | Unique numeric sensor ID |
| `name` | ESP | Display name (the WebUI edits it here) |
| `notes` | WebUI | Free text |
| `kind` | WebUI | `loadcell` (default), `temperature` or `generic`. Tells the WebUI how to use the channel |
| `type` | ESP | Driver (`hx711`, `temperature`, …) |
| `enabled` | ESP | Sensor active |
| `unit` | ESP | Meaning/unit of **raw** (e.g. `ADC count`, `m°C`, `mΩ`) |
| `rawFormat` | ESP | How to read the transported uint64 `raw` (§5.2) |
| `rate_hz` | ESP | Nominal sampling rate. Required for **every** sensor (HX711: 10 or 80) |
| `ringbuffer_size_samples` | ESP | Retained samples |
| `hx711{…}` / other driver blocks | ESP | Unchanged from v0.2 |
| `warnings` | ESP | Raw-value over/underload, **two thresholds in total**, with hysteresis (property names for hysteresis: ESP decides) |
| `attachedTo` | WebUI | Load-cell sensor IDs an auxiliary channel belongs to (list of numbers) |
| `conversion` | WebUI | Conversion of `raw` to a physical value (§5.3). **One** conversion per channel; no separate firmware/user variants |
| `calibrationFile` | WebUI (ESP will need it later) | File name of the active calibration of a load cell, or `null` |
| `primaryTemperatureSensorId` | WebUI | Temperature channel used for the uncertainty estimate, or `null` |
| `loadLimits` | WebUI | Weight-based overload monitor of the browser (§5.4). The ESP stores it and ignores it for now |

### 5.2 `rawFormat` [Agreed: transport is always uint64, WebUI converts]

`raw` is **always an unsigned 64-bit integer** on the wire (JSON and binary). `rawFormat` says how the WebUI decodes it. The uint64 holds the sensor's native value **zero-extended**, as bit pattern:

| `rawFormat` | Native value | Content of the uint64 |
|---|---|---|
| `uint32` / `uint64` | unsigned | the value |
| `int24` | signed 24-bit (HX711) | the 24-bit two's-complement pattern (bits 0..23), upper bits 0 |
| `int32` / `int64` | signed | two's-complement pattern of that width, upper bits 0 for `int32` |
| `float32` | IEEE-754 single | the 32 bits |
| `float64` | IEEE-754 double | the 64 bits |

The WebUI handles JSON integers above 2^53 itself. The ESP sends plain unsigned integers. No sensor-type-specific history layout is needed.

### 5.3 `conversion` (WebUI-defined, opaque to the ESP)

```json
{ "type": "polynomial", "coefficients": [-12.3, 0.0042], "rawScale": 1, "unit": "°C" }
```

| `type` | Parameters | Definition (x = raw decoded × `rawScale`, `rawScale` default 1) |
|---|---|---|
| `direct` | none | y = x |
| `polynomial` | `coefficients` `[c0, c1, …]` | y = c0 + c1·x + c2·x² … |
| `steinhart-hart` | `a`, `b`, `c` | x = resistance in Ω; 1/T = a + b·ln x + c·(ln x)³ (T in K); y = T in °C |
| `beta` | `beta`, `r0`, `t0` (°C), optional `rSeries` | x = resistance in Ω; R = x − rSeries; 1/T = 1/(t0+273.15) + ln(R/r0)/beta; y = °C. *`rSeries` meaning (series resistance subtracted) is a WebUI assumption, ESP side to confirm.* |

- `unit` = unit of the converted value. Temperature channels must deliver `°C`.
- A failed conversion is an **invalid sample (NaN)**, never 0.
- **[Open]** More elaborate conversions (user formulas) are planned. The object stays opaque for the ESP, so new `type` values need no firmware change. If the ESP worker has a richer conversion specification, send it.

### 5.4 `loadLimits` (WebUI monitor; ESP only stores it)

| Key | Meaning | Default |
|---|---|---|
| `maxLoad` `{value, unit}` | Upper limit as a weight (unit id from `units.json`); `null`/missing = monitor off | off |
| `minLoad` `{value, unit}` or `null` | Lower limit; `null` = −maxLoad | `null` |
| `averageS` | Averaging time of the newest samples (s) | 0.1 |
| `yellowPercent`, `orangePercent`, `redPercent` | Excess above the limit that triggers each level (rising) | 10, 20, 40 |
| `breakS` | Gaps shorter than this stay one event (s) | 0.5 |
| `holdS` | Keep the warning visible (s) | 8 |

These are calibrated-mass limits evaluated in the browser. They are independent of the ESP's raw `warnings` thresholds (hardware limits). The WebUI shows ESP `warning` events in addition.

### 5.5 Change handling [Proposal, see API doc §7]

The ESP classifies a `sensors.json` PUT per changed key: WebUI-owned keys, `name`, `calibrationFile` etc. are **applied** without touching sensors. Changing `rate_hz`, `type`, `rawFormat`, driver blocks or `ringbuffer_size_samples` needs sensor reconfiguration. Ring-buffer resize mode is selected with the query parameter `?buffer=preserve|clear` (default `preserve`).

## 6. `units.json` [WebUI-owned]

The WebUI's existing unit table, verbatim. The ESP stores and serves it, and validates **structure only** (JSON object, `schemaVersion`, `units` array).

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

- `factor` converts the canonical unit (milligram) to the display unit: value in unit = mg / `factor`. `factor: null` marks the non-physical `raw` entry.
- Factory default = the table above (DELETE restores it). The WebUI also embeds this table as fallback.

## 7. `webui-settings.json` [WebUI-owned]

Server-side default of the WebUI's interface preferences (each browser may keep its own copy in local storage). The ESP stores and serves it without interpretation. `{}` is valid and means "built-in defaults". Factory default: `{}`.

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

- Missing keys fall back to built-in defaults; unknown keys are ignored.
- **[Agreed] Not stored in any file:** tare state, time since tare, and the "typical use" assumptions of the uncertainty estimate (reading delay, session since tare, temperature difference). They live only in the browser session.
- The selected index page is **not** here, it is `http_indexpath` in `settings.json`.

## 8. Calibration files [WebUI-owned schema, stored compressed]

- **Path:** `/data/calibration/calibration_<sensorId>_<profileId>.json`. Any number of files per sensor. The **sensor ID is part of the filename**: `<sensorId>` is the decimal sensor ID, `<profileId>` is `[A-Za-z0-9._-]+`. The WebUI parses `^calibration_(\d+)_(.+)\.json$` from `/api/files` to list and assign files. The document also contains `"sensorId": <number>` (equal to the filename's).
- **Compression [Agreed]:** the WebUI uploads gzip bytes with `Content-Type: application/json` and `Content-Encoding: gzip`. The ESP stores the bytes as received and serves them with `Content-Encoding: gzip` (the browser decompresses). The ESP does **not** decompress or validate them for now (future feature, see §10).
- **Active calibration** of a sensor is `calibrationFile` in `sensors.json` (§5), not a field of the calibration files.
- **Size:** unknown in advance; the WebUI estimates roughly 30 to 250 KB uncompressed JSON, far less gzipped (observations carry validity checks and optional time series). The ESP decides the limit; the WebUI will show compressed size and free space while a calibration is being created and handles HTTP 507.
- **Schema:** the WebUI owns it. Top-level keys: `schemaVersion`, `sensorId`, `profileId`, `profileName`, `createdAt`, `modifiedAt`, `applicationVersion`, `calibrationUnit`, `calibrationMethod`, `sensor`, `environment`, `referenceWeights`, `referenceWeightGroups`, `referenceLoads`, `observations`, `calibrationAnchors`, `fit`, `uncertainty`, `characterization`, `validation`, `reserved`, `revisionId`, `contentHash`. The ESP never needs to read it.
- `GET`, `PUT`, `DELETE` on the same URL. Protection: see §2 and open point 1.

## 9. Future file formats (reminder, "maybe-TBD")

- **`checkweighings.json`** (long-term drift log, format exists in the WebUI, no UI yet). Proposed location: `/data/user/checkweighings.json`, stored compressed like calibration files. More such WebUI data files may follow; **all will be stored compressed**.
- **ESP-side validation of calibration files** (needs decompression of larger files; the ESP worker should see whether this is feasible).
- **ETag / `If-Match`** on settings files, to stop two browsers overwriting each other (GET-modify-PUT race). Judged unlikely and complex, so omitted for now.
- **ESP using calibration files** (e.g. weight-based overload on the device).

## 10. Notes for the ESP worker

1. No `PATCH`: the ESP must work out by itself what a whole-file PUT changes (e.g. compare new GPIOs with the active ones) and report it (API doc §7).
2. `wifi.json`: stable network `id`, password stripping on GET, merge on PUT, atomic replace via `.tmp` file.
3. Preserve unknown keys in `sensors.json` (WebUI keys).
4. Calibration files are opaque gzip blobs; do not decompress; filename carries the sensor ID.
5. Define the **device-log** entry layout and its types (API doc §6). This is a todo for the ESP worker.
6. Define the sample-flag bit assignments (API doc §4.3).
7. The WebUI must be able to show the detailed error text the ESP puts into HTTP error bodies.

## 11. Open points

1. Calibration `DELETE` is unprotected in ESP v0.2 ("PUT only"), although "all other mutating operations are protected". Intended? WebUI assumes DELETE is protected like PUT.
2. `wifi.json`: treatment of networks missing from a PUT (WebUI proposes: deleted).
3. Hysteresis property names for `warnings` (ESP decides; the WebUI does not read the thresholds).
4. Exact object path of the administrator password field in `settings.json`.
5. Beta-conversion `rSeries` semantics (hardware knowledge needed).
