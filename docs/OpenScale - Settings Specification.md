# OpenScale — Settings Specification

**Document status:** Working draft  
**Version:** Draft 0.1  
**Purpose:** Describe firmware configuration files and behaviour for firmware and WebUI development.

> This is a structural specification, not a finalized JSON schema. Exact field names, defaults, ranges and endpoint paths must be agreed before implementation. Names explicitly identified as tentative should not be treated as final.

## 1. Configuration principles

- Configuration is stored as JSON.
- Configuration JSON files are stored uncompressed on flash to simplify validation, recovery and atomic replacement.
- WebUI static assets are a separate category and are always gzip-compressed.
- Use separate files for system, Wi-Fi, sensor and WebUI configuration.
- The ESP32 does not interpret the WebUI's private settings.
- Never return Wi-Fi credentials or other secrets in plaintext through ordinary settings reads.
- Validate updates before applying them.
- Prefer transactional writes: write a temporary file, validate it, then atomically replace the active file where the filesystem supports it.
- A failed update must not corrupt the previous valid configuration.

## 2. Proposed configuration files

| File | Responsibility | Firmware reads it? |
|---|---|---|
| `settings.json` | System-wide settings, security-related configuration, hostname, HTTP index selection and general resource policy | Yes |
| `wifi.json` | Saved Wi-Fi networks, priority, credentials and AP configuration | Yes |
| `sensors.json` | Sensor definitions, drivers, GPIO/acquisition settings, buffers and thresholds | Yes |
| `webui-settings.json` | WebUI-only preferences | No; treated as UI-owned data |
| `/data/calibration/*.json` | Multiple calibration documents; each document identifies its applicable sensor/type | Firmware reads/validates as defined by calibration implementation |

Names and exact storage roots should be confirmed during API/filesystem design. `webui-settings.json` is the full filename; do not abbreviate it to `webui.json`.

## 3. `settings.json`

System-wide settings. The following is illustrative:

```json
{
  "http_indexpath": "/default.html",
  "hostname": "openscale_a1b2c3",
  "redirectToHostname": false
}
```

### `http_indexpath`

- Selects the file served when the client requests `/`.
- Allows a user to upload a custom WebUI entry file and select it.
- Default should point to the firmware-provided default page.
- Must resolve to an allowed static asset path.
- Must not allow protected configuration/calibration files or path traversal.

### `hostname`

- If unset on first initialization, generate a hostname partly derived from the device MAC address.
- Persist the generated value so it remains stable across boots.
- Allow the user to change it.
- mDNS name resolution and HTTP redirect are separate behaviours.

### `redirectToHostname` (tentative name)

- Controls whether HTTP requests made through an IP address are redirected to the hostname.
- Must avoid redirect loops.
- Redirect should be avoided where the hostname is not expected to resolve, including relevant AP-mode cases.
- A serial recovery command should be available to disable redirect if necessary.

Other system/security/memory settings may be added as requirements become clear. Do not invent a setting solely to expose an implementation detail.

## 4. `wifi.json`

Stores a prioritized list of saved Wi-Fi networks and access-point configuration.

Requirements:
- Support multiple saved SSIDs.
- Attempt saved networks in configured priority order.
- Support retry/reconnect behaviour.
- Provide fallback AP operation.
- AP+STA operation is desired where supported.
- Credentials must be treated as secrets and omitted/redacted from ordinary GET responses.
- Updating Wi-Fi settings should not require a full reboot if the driver can reconfigure safely; report the actual application requirement.

Illustrative shape only:

```json
{
  "networks": [
    {
      "ssid": "network-one",
      "password": "secret",
      "priority": 1
    },
    {
      "ssid": "network-two",
      "password": "secret",
      "priority": 2
    }
  ],
  "accessPoint": {
    "enabled": true
  }
}
```

Exact field names, AP credentials/security policy, retry intervals, connection timeouts and priority semantics are **TBD**.

## 5. `sensors.json`

Contains sensor definitions. Every sensor has a unique numerical `sensorId` and a driver type supported by the firmware.

The configuration should accommodate:
- Sensor ID and type/driver.
- Enabled/disabled state.
- Driver-specific acquisition settings.
- GPIO assignments where applicable.
- Per-sensor history capacity.
- Optional raw-value upper/overload and lower/underload thresholds.
- Hysteresis configuration.
- Sensor-specific metadata such as unit/raw interpretation where needed.

Illustrative shape only:

```json
{
  "sensors": [
    {
      "sensorId": 0,
      "type": "hx711",
      "enabled": true,
      "bufferCapacity": 10000,
      "thresholds": {
        "upper": null,
        "lower": null,
        "hysteresis": 0
      },
      "config": {
        "dout": 16,
        "sck": 4
      }
    }
  ]
}
```

This example is not a final schema. GPIOs, sampling options, raw ranges and thresholds must be validated by the selected driver/type.

### Sensor buffer capacity

- Each sensor has its own ring buffer.
- Capacity can be changed at runtime when memory allows.
- The request should select a resize behaviour:
  - `preserve`: retain the newest samples that fit.
  - `clear`: release the old allocation before allocating the new capacity; clear that sensor's history.
- Allocation failure must be reported. Do not silently apply a different capacity.
- Actual allocated capacity, usage and memory availability should be visible in runtime status.
- Exact field name and API representation are **TBD**.

### Thresholds and hysteresis

- Thresholds compare raw sensor values.
- Upper/lower thresholds are optional.
- Hysteresis prevents repeated activation/deactivation near a boundary.
- Firmware records warning state in sample flags and emits an SSE warning event on transitions.
- Exact activation/deactivation formulas and per-sensor field names are **TBD**. The WebUI may implement more sophisticated interpretation, but firmware provides basic consistent warning detection.

## 6. `webui-settings.json`

- Owned and interpreted by the WebUI.
- The ESP32 stores and serves it but does not need to parse or act on its contents.
- Use the full filename `webui-settings.json`.
- It should be handled as a JSON resource and use a `.json` path.
- Do not mix its contents into firmware `settings.json`.

## 7. Calibration documents

- Allow as many calibration JSON files as storage capacity and user choice permit.
- Do not enforce one calibration file per sensor.
- A calibration document identifies the sensor/type it belongs to internally.
- The URL/path does not assign the calibration to a sensor.
- Example resource path: `/data/calibration/example.json`.
- Use the same path for GET (retrieve) and PUT (create/replace); DELETE removes it.
- Calibration JSON is protected data, not an arbitrary static asset.
- Exact schema, validation rules and calibration activation/selection behaviour are **TBD**.

## 8. Runtime application and restart policy

Every setting update should report its application status. Use these conceptual categories:

| Category | Meaning |
|---|---|
| Applied immediately | New value is active without stopping acquisition or restarting the device |
| Sensor reconfiguration required | Affected sensor driver must be stopped/reconfigured/restarted |
| Device restart required | Full ESP32 restart is necessary |
| Rejected/not applied | Validation, storage or resource allocation failed |

The WebUI decides when to request a full device restart. The firmware must not reboot automatically merely because a setting was changed.

Where a setting is saved but not yet active, the firmware should make that distinction observable so the WebUI can show pending changes.

A runtime buffer resize should not require a sensor acquisition restart where reasonably possible.

## 9. Serial recovery/configuration commands

Use consistent command naming with the action after the subject, for example:

```text
wifi_set
wifi_clear
password_set
password_clear
hostname_set
debug_set
```

These are naming examples; exact syntax, arguments, confirmation behaviour and help output are **TBD**.

Serial recovery should provide a way to regain access if network credentials, admin password or hostname redirection settings prevent normal access. Avoid printing secrets unnecessarily.

## 10. Validation and storage requirements

- Reject malformed JSON.
- Validate required fields, types, ranges, uniqueness of sensor IDs and driver-specific constraints.
- Reject unknown/unsafe filesystem paths and path traversal.
- Protect firmware default assets and reserved data paths.
- Do not expose secrets in normal read responses.
- Preserve the previous valid configuration if an update fails.
- Report storage-full and allocation failures distinctly where possible.
- Consider schema/config version fields to support future migrations; exact versioning mechanism is **TBD**.

## 11. Open settings decisions

- Final JSON schemas and exact field names/defaults/ranges.
- Exact configuration file paths and API routes.
- Wi-Fi retry/timeout policy and AP configuration.
- Exact buffer capacity units and resize request/response schema.
- Threshold and hysteresis semantics.
- Calibration schema and active-calibration selection model.
- Hostname redirect policy in AP mode.
- Serial command argument syntax.
- Configuration schema migration/version policy.
