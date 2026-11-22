# Mass Telemetry Workbench: handout v17 (read after v16; overrides it where they differ)

Baseline: `telemetry_workbench_v17.html` + `.js`, `audit_harness_v17.js` (`node audit_harness_v17.js telemetry_workbench_v17.html`), `sensors_example_v0_5.json` (replaces `sensors_example*.json`).
Contract: `api-protocol_v0_5.md` + `json-file-formats_v0_5.md`. **654 harness checks pass. Still not browser-tested, never run against a real ESP32.**

## 1. What changed (v16 → v17)
| Area | Now |
|---|---|
| Startup | status + device → units / files / webui-settings → sensors.json → the calibration each sensor names → status again → device log → **only then** `/stream` (`startupHold`). No device reachable: test signal only, everything else as before. `deviceStartup` |
| Transport | ONE `EventSource('/stream')`; events `sample`, `warning`, `device`, `sensor_error`, `device_log`. Pause of one sensor drops its data; the stream closes only when all are paused. `handleSseEvent` |
| Numbers | Lossless JSON (`parseWire`: 16+ digit runs → BigInt). `raw` is a uint64 bit pattern decoded by the sensor's `rawFormat` (uint32, uint64, int24, int32, int64, float32, float64; `decodeRaw`). `state.raw` is now **Float64Array** (was Int32). `t` is µs → ms; **one clock for the whole device**; `n` per sensor |
| Sensor list | `sensors.json` only: numeric ids, `kind` (loadcell default / temperature / generic), `rawFormat`, `rate_hz`, `enabled`, `attachedTo`, `conversion {type, rawScale, unit, …}` (ONE per channel), `calibrationFile`, `primaryTemperatureSensorId`, `loadLimits`, `notes`, `name`. `sensor_settings.json`, `ui-settings.json`, `sensors_example*.json` are gone |
| Writing sensors.json | The last received document is kept; only WebUI-owned keys are changed, everything else (GPIOs, warnings, driver blocks) goes back untouched. `sensorsDoc`, Settings → Sensor → "Apply & send sensors.json". `?buffer=` is not exposed (device default `preserve`) |
| Writes | Every PUT/POST/DELETE has `X-CSRF-Token`; 403 → one status refresh + one retry; 401 → our dialog once (unchanged); answers `{status, saved, errors, warnings, pendingChanges}` are shown; HTTP error bodies are shown (507 / 413 in plain words). `serverWrite`, `httpErrorText`, `writeResultText` |
| Status | Polled every 3 s (every 30 s while no device was found): boot id, CSRF token, `pendingChanges` (shown in the status line and Settings → Device), effective `rate_hz`, per-sensor state, `oldestId` (floor for history requests) |
| Epochs | **Nothing is deleted.** New `bootId` (from status, or from the SSE `id:` prefix) or a changed `configRevision` → the buffer becomes a read-only entry in the sensor list ("Scale · earlier epoch 1 (…)", id `<id>@<n>`), the live sensor continues empty. Notes in both logs and in the device log. `warningRevision` is ignored. After a configuration epoch older history is **not** loaded (it may have another meaning). Details §2 |
| Warnings / events | Firmware overload/underload: red banner item "FIRMWARE … WARNING", log row, red marker line on the chart. `sensor_error` → sensor link "sensorerr"; `device` event → status line; `device_log` → new "Device log" pane (dedupe on boot id + `logEntryId`) |
| History | `GET /api/history?sensor_id&from_id&to_id&limit&format=bin`; binary layout v1 (28-byte records, flags); JSON accepted; chunk ≤ min(5,000, `maxHistoryChunk`, `X-History-Max-Chunk`); `X-History-Oldest-Id` ends the loading. Old 12/16-byte layouts removed |
| Calibration files | `calibration_<sensorId>_<profileId>.json` (test signal: `calibration_test_…`, never uploaded); `profileId` must match `[A-Za-z0-9._-]+`, `sensorId` a whole number; listed from `/api/files`, loaded on demand from `/data/calibration/…`; gzip upload (`CompressionStream`) via Settings → "Send to device" or the wizard; wizard shows compressed size, free flash, upload limit |
| Settings | `webui-settings.json` replaces `ui-settings.json` (`{"schemaVersion":1}` = factory default). Units: `units.json` from the device replaces the embedded table when valid (embedded one now has `schemaVersion`). New Settings → **Device**: info, restart (`POST /api/restart`, asks first), reset a settings file (DELETE; extra warnings for `settings.json` = removes the admin password, `wifi.json`, `sensors.json`) |
| uPlot | Served by the device (asset from `/api/files` matching `uplot`); jsDelivr only as fallback. No CDN setting is saved |
| Use conditions | Reading delay, time since tare, ΔT: **browser session only**, never in a file. Primary temperature channel = `primaryTemperatureSensorId` in sensors.json |

## 2. Decisions to check
1. **Active calibration vs. saved default.** `settings.calibrationFile` is what is active in this browser (switching in Settings or the wizard is temporary). It is written to `sensors.json` only with "Apply & send". At startup the file named in sensors.json is activated on a sensor **without samples** (no epoch, no tare reset); a file that is missing/inconsistent (name vs. content) is refused with a log entry and the demo calibration stays.
2. **Epoch trigger latency:** a config change is noticed on the next status poll (≤ 3 s); samples arriving meanwhile still go into the old buffer, and the list is reloaded afterwards (`rawFormat` change!) so wrongly decoded samples are possible for those seconds. A restart is noticed immediately through the SSE id.
3. **Archives stay in memory** (RAM) until "Clear charts / Clear all" (both ask). An archive of an auxiliary channel whose *own* configRevision changed is kept as an unattached "archived channel" (data retained, not shown anywhere yet).
4. **Flags** are counted, not stored per sample (bits 2–4 live: `state.flagged`); a live sample with bit 4 on an auxiliary channel is stored invalid (NaN). Bits 0/1 are ignored (own overload logic + firmware warning events).
5. **int64/uint64 above 2^53** lose low bits when converted to a JS number (the lossless step is the parsing; the calibration works on doubles).
6. **Backwards `n` and `t`** only trigger an extra status poll (second hint); `bootId` stays authoritative.
7. Initial history is loaded **backwards from the first live sample** (merge by id/time) rather than before the stream opens; result identical, live samples are never held back.
8. Device info field names (`product`, `firmwareVersion`, `chip.model`) are read tolerantly; the spec lists contents, not names.
9. `loadLimits` with an unknown unit id is refused with a message (units.json is loaded first).
10. Calibration DELETE, static-asset PUT, Wi-Fi/settings.json editing, `unixtimestamp` (wall clock) and the `?buffer=` choice have **no UI**.

## 3. Test adapter
`audit_harness_v17.js` keeps the v11–v16 fixtures through a small **adapter** (letter ids → numeric, old message → one v0.5 `sample` event, µs, integer raw), so the old tests still run on the real code. Tests that depended on URLs / ids / file names were edited; the old transport tests were replaced. New groups: V0 (lossless parse, rawFormat), N1–N10 (raw formats via SSE, restart/config epochs, firmware warnings, errors, device log, startup order against a mock device, units.json, CSRF/gzip/reset/restart, history headers and chunk size, webui-settings), A10 (CSRF retry), W7 (sensors.json round trip).

## 4. Browser checklist (never done; ★ new)
All v16 items, plus ★ startup against the real device (order of requests, uPlot from the device, stream opens last) · ★ units.json replacing the select (grouping) · ★ epoch switch while a sensor is shown (charts rebuilt, selector shows the archive, archive chart + its temperature axis) · ★ red firmware banner + chart marker line · ★ Device log pane · ★ Settings → Device (info, restart, reset warnings) · ★ gzip upload and the size line in the wizard (Chrome/Firefox/Safari `CompressionStream`) · ★ 401 + CSRF 403 flow against the real server · ★ `Content-Encoding: gzip` GET of calibration files by `fetch` · ★ SSE reconnect after a restart (id prefix, `onopen` status poll).

## 5. Open / next
Reminders from §0 of handout v16 (buoyancy compensation, License Info in menu, temperature correction as own epoch, OIML table, CSV sample-id column, checkweighings UI, navigator display of channels, per-channel pause) · UI for `?buffer=preserve|clear`, calibration DELETE, device-log filtering by type · wall-clock labels from `unixtimestamp` · a mock ESP server for browser tests · memory use of many archived epochs (consider a total sample budget).
