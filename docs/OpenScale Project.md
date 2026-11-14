# ESP32 Sensor Node

An ESP-IDF C++ firmware scaffold for collecting sensor samples, retaining bounded per-sensor history, and exposing live data and device management over HTTP/SSE.

This first milestone intentionally concentrates on the firmware boundary. The full WebUI is a separate project. `main/www/default.html` and `main/www/default.js` are only a small diagnostics/recovery page; they are embedded as gzip assets and copied to the flash filesystem on first boot.

## Status and scope

Implemented in this scaffold:

- One FreeRTOS acquisition task per enabled HX711 sensor.
- A shared, thread-safe FreeRTOS queue carrying sensor ID, per-sensor sequence number, monotonic timestamp in microseconds, and raw value.
- A collector task that writes into bounded, per-sensor ring buffers.
- A total ring-buffer memory budget and queue-overflow/read-error counters.
- One multiplexed SSE endpoint (`/stream`) for all enabled sensors. It uses ESP-IDF asynchronous HTTP handling so long-running SSE connections do not hold the ordinary HTTP server task.
- Per-sensor history queries and device/runtime/total-free-largest heap, queue allocation, flash/filesystem and ring-buffer status.
- Wi-Fi station connection with fallback WPA2 access point.
- JSON settings validation, atomic-ish temporary-file replacement, settings/sensor updates, calibration upload, and gzip web-asset management.
- Serial commands for emergency Wi-Fi and HTTP/password configuration.

Explicitly deferred:

- HTTPS/TLS server (the `https.enabled` setting is reserved and must remain `false`).
- OTA firmware updates.
- The final WebUI.
- Additional sensor drivers and calibration application to sensor values.
- NTP/wall-clock synchronization. Sample timestamps are monotonic time since boot, not UTC.

## Toolchain

Target ESP-IDF **v5.5.6 or later in the 5.5 branch**. The newer ESP-IDF 6.x line may require component/API migration and has not been validated here. The code uses ESP-IDF components only; no Arduino framework or third-party sensor library is required.

The project is configured for a 4 MB flash layout. Select the actual chip and flash size before building. The custom partition table reserves 2 MB for the factory application and approximately 1.94 MB for FATFS storage. Boards with a different flash capacity need a matching `partitions.csv` and `sdkconfig`.

```sh
idf.py set-target esp32
idf.py build
idf.py -p PORT flash monitor
```

Replace `esp32` with the actual target (for example `esp32s3`, `esp32c3`, or another supported target). The configured GPIO pins must exist and be usable on that chip. Some newer ESP32 variants do not expose the same GPIO numbering or peripheral resources as the original ESP32.

## First boot and network

1. Flash the firmware and open the serial monitor at 115200 baud.
2. On first boot the storage partition is formatted if necessary, default JSON files are created, and the embedded `default.html.gz` / `default.js.gz` files are seeded into `/data/www/`.
3. If an SSID is present in `settings.json`, the firmware tries station mode. If it is empty or connection fails, it starts a WPA2 access point.
4. The AP SSID is `<ap_ssid_prefix>-<last-two-MAC-bytes>` and the generated password is printed to the serial log. The AP gateway is `192.168.4.1`.
5. Open `http://<device-ip>/` or `http://192.168.4.1/`.

The AP password is derived from the device MAC for bootstrap convenience. Treat it as a setup credential, not a high-assurance secret; change the design before deploying devices in an untrusted environment. **Set the administrator password over the serial console before using the device on a network you do not fully trust.**

## Serial recovery commands

The UART console remains available even if Wi-Fi or HTTP is disabled. If the essential `settings.json` cannot be parsed, network services are deliberately kept off until the settings are repaired from serial; this avoids falling back to an unauthenticated network after a configuration failure.

```text
status
set-wifi <ssid> <password-or-dash-for-open-network>
set-password <new-password-at-least-8-characters>
clear-password
set-http on|off
help
```

`set-wifi` uses `-` for an open network. Configuration commands save `settings.json` and restart the device. The password is entered as a console command and may be echoed or retained by the terminal; use a trusted serial session.

## Sensor configuration

The seed `config/sensors.json` mirrors the three entries in the supplied `sensors_example.json`, but IDs are numeric as requested. Only sensor ID `0` is enabled because the supplied C example identifies only DOUT GPIO 16 and SCK GPIO 4. Sensor IDs `1` and `2` are disabled with `null` pin values rather than invented wiring.

Example:

```json
{
  "id": 0,
  "name": "Scale 1",
  "type": "hx711",
  "enabled": true,
  "rate_hz": 80,
  "ring_buffer_samples": 1600,
  "hx711": {
    "dout_gpio": 16,
    "sck_gpio": 4,
    "rate_gpio": null,
    "gain": "A128"
  }
}
```

HX711 `rate_hz` accepts 10 or 80. If `rate_gpio` is set, firmware drives it low for 10 Hz and high for 80 Hz. If it is `null`, the HX711 module's physical `RATE` pin must already be strapped to the chosen mode. The firmware does not software-schedule the converter's rate. `gain` accepts `A128`, `A64`, or `B32`.

The HX711 driver returns signed 24-bit raw ADC values. No offset, scale factor, unit conversion, filtering, or calibration is applied yet.

`ring_buffer_samples` is the number of samples per sensor. The firmware checks the sum of `ring_buffer_samples * sizeof(RingEntry)` against `storage.max_ring_buffer_bytes` before allocating. The queue capacity is set by `queue_capacity`. The queue is non-blocking for acquisition: if it fills, the sample is dropped and that sensor's `queue_drops` counter increases. The sample sequence still advances, so gaps can be detected by clients.

## HTTP API

All endpoints use the same HTTP server.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Serve the selected index asset |
| GET | `/stream` | SSE stream containing samples from every sensor |
| GET | `/api/device` | Runtime, memory, flash/filesystem and sensor/ring status |
| GET | `/api/history?sensor_id=0&limit=128` | Last samples for one numeric sensor ID (limit 1–512) |
| GET | `/api/files` | List gzip web assets and report index/immutable flags |
| PUT | `/api/config/settings` | Validate and replace critical settings; restarts after response |
| PUT | `/api/config/sensors` | Validate sensors and ring-buffer memory budget; restarts after response |
| PUT | `/api/config/webui` | Replace WebUI-only JSON settings |
| GET | `/api/calibration` | List calibration files and report basic JSON-object validation |
| PUT | `/api/calibration/<name>.json` | Save calibration JSON; invalid or empty content is still saved and reported |
| DELETE | `/api/calibration/<name>.json` | Delete a calibration file |
| GET | `/data/settings/settings.json` | Settings file; secrets redacted until admin password is configured |
| GET | `/data/settings/sensors.json` | Sensor settings file |
| GET | `/data/settings/webui-settings.json` | WebUI settings file |
| GET | `/data/calibration/<name>.json` | Read saved calibration data |
| PUT | `/api/files/<web-path>` | Upload a gzip-compressed static asset |
| DELETE | `/api/files/<web-path>` | Delete a static asset (not any `default.*` asset) |
| POST | `/api/files/index` | Set index, body: `{"path":"/index.html"}` |
| POST | `/api/files/rename` | Rename asset, body: `{"from":"old.js","to":"new.js"}` |
| POST | `/api/restart` | Restart the device |

### SSE event format

The stream sends `event: samples` events. On connection it starts at the current live edge rather than replaying the ring buffer; historical samples are fetched separately through `/api/history`. Each dispatch limits how many queued history samples one sensor can contribute, so an unusually backed-up sensor cannot starve the others. Open the stream first, then fetch each sensor's history and deduplicate the brief overlap using `sensor_id` plus `seq`:

```text
id: 12
event: samples
data: {"samples":[{"sensor_id":0,"seq":42,"timestamp_us":1234567,"raw":838860}]}

```

The actual stream has no leading spaces before `event` and `data`. `timestamp_us` is monotonic microseconds since boot. Each sensor's `seq` is independent and increases per acquired sample. A gap can mean a queue drop; inspect `/api/device` for the corresponding cumulative drop count. The stream task wakes every 12 ms (about 83 Hz) and sends whenever new samples are available; it does not fabricate samples if a sensor is slower than the stream cadence. Up to three concurrent SSE clients are accepted in this first version.

### History

History is intentionally queried per sensor to keep memory and response sizes bounded. Example:

```sh
curl 'http://192.168.4.1/api/history?sensor_id=0&limit=128'
```

The response includes the last sequence IDs and timestamps in the selected sensor's ring buffer. The WebUI can use `newest_sequence` as the cursor; this scaffold currently returns the latest `limit` samples only and does not yet support cursor-based pagination.

## Web files and compression

- Built-in `default.html` and `default.js` are embedded gzip files and seeded into `/data/www/`.
- All static assets in `/data/www/` are stored as gzip (`<web-path>.gz`) and served with `Content-Encoding: gzip`.
- Asset uploads must send `Content-Encoding: gzip`; the firmware checks the gzip magic bytes before accepting the file. This keeps the ESP free of a runtime compressor and allows files to be streamed directly from flash to the browser.
- All `default.*` filenames are reserved and cannot be overwritten, deleted, or renamed through the file API. This first version accepts flat filenames only (no nested web directories); JSON settings remain in their dedicated protected `/data/settings/` namespace and JSON is not accepted as a generic web asset.
- `webui-settings.json` holds the selected `index` path. The default is `/default.html`.
- `/data` is not part of the generic static-file namespace. Only explicit settings and calibration paths are registered.

The example default page is deliberately small. The separately authored WebUI can be uploaded as other assets and selected as the index.

## JSON storage and flash wear

Settings, sensor configuration, WebUI settings and calibration files are stored as ordinary JSON on FATFS. This is intentional for the first milestone: critical configuration must be parsed and validated before replacement, and temporary-file replacement is easier to reason about with uncompressed content. Static assets are gzip-compressed.

The storage partition is FATFS over ESP-IDF wear levelling. The mount currently enables `format_if_mount_failed` so a new blank partition is initialized automatically. **A filesystem mount failure can trigger formatting and loss of stored files.** For deployments where preserving configuration is more important than automatic recovery, change this to `false` and add an explicit serial-only recovery/format command.

## Authentication and transport security

When an admin password is set, all mutating HTTP operations (configuration writes, asset upload/delete/rename/index, calibration upload and restart) require HTTP Basic authentication. Settings reads are also authenticated when a password exists. The administrator password is stored as a salted PBKDF2-HMAC-SHA256 verifier rather than plaintext. The Wi-Fi station password must be stored in recoverable form so the ESP can reconnect; this scaffold keeps it as plaintext in `settings.json` on the FATFS partition.

**Important:** HTTP Basic credentials are only Base64-encoded, not encrypted. Over plain HTTP they can be observed by anyone able to monitor the Wi-Fi network. Use this firmware only on a trusted network until HTTPS is implemented. Do not assume hashing the stored password protects credentials in transit. HTTPS is deliberately deferred and `https.enabled: true` is rejected by settings validation. Disabling HTTP before a future HTTPS implementation will leave serial as the only management channel.

There is no CSRF protection in this initial firmware. Do not expose the device directly to the public internet.

## Example settings and paths

Runtime files:

```text
/data/settings/settings.json
/data/settings/sensors.json
/data/settings/webui-settings.json
/data/calibration/<name>.json
/data/www/<web-path>.gz
```

The generic web-asset API cannot write into `/data`; configuration and calibration have dedicated handlers and validation rules.

## Known first-milestone limitations

- No OTA, TLS/HTTPS, mDNS, captive portal, or NTP.
- No OTA safety/recovery partition yet; the supplied partition table has a single factory app slot.
- No calibration schema beyond checking that submitted content is a JSON object; calibration bytes are saved even when invalid.
- `GET /api/history` requires `sensor_id`; pagination by sequence cursor is a follow-on improvement.
- The sample timestamp is taken after the HX711 read completes, so it is a read-completion timestamp, not an exact converter conversion-start timestamp.
- The ESP-IDF toolchain is not bundled. Build and hardware-test on the chosen chip/board before relying on GPIO timing, Wi-Fi coexistence, or the 80 Hz cadence.

## License

This project is intended to be distributed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`). See `LICENSE` for the SPDX license identifier and official license text URL.
