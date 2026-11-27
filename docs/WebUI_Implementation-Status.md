# Mass Telemetry Workbench: handout v18 (read after v17; overrides it where they differ)

**Handout version:** 18 · **Date:** 2026-11-27 10:36 UTC · **Authors:** Claude (AI collaborator) + Humans
**Co-authored-by:** Claude
**WebUI version this handout prepares:** v0.18 (the repo `/WebUI` is on v17 until patches 1 to 3 below are applied and committed)

Contract documents (in `/docs`, file names now start with "OpenScale"): `OpenScale - API Protocol.md`, `OpenScale - JSON File Formats.md`, `OpenScale - Project Requirements.md`, plus `ESP32_Implementation-Status.md`. Older handouts mention `api-protocol_v0_5.md` / `json-file-formats_v0_5.md`: same documents, renamed.

**Status of everything below: never run in a browser by Claude. The first real-device tests were done by the user on v17 (findings in §3). The v0.18 changes exist only as three patch scripts that were checked with stubs, not applied to the real files by Claude.**

## 0. Working rules (from the user)
- Add the Claude credit/co-author to commits and into docs. Docs get an incremented version plus date and time (UTC).
- Commit prefixes: `[WebUI]` and `[Docs]` (the latter only for non-handout docs).
- Access: GitHub `High-on-Voltage/OpenScale`. `/WebUI` is Claude's folder (on v17), `/docs` is shared, **do not touch other folders**. This handout is always `WebUI_Implementation-Status.md`.
- Claude had **no GitHub access in the last session** (no network in the sandbox, repo not mounted). Work was delivered as patch scripts. If the next session has repo access, apply the changes directly instead and delete the scripts' role (see §2).
- The user said: **no more coding in the session that produced this handout**. The next session starts from this file.

## 1. Baseline and how v0.18 is built
Baseline: `WebUI/default.html`, `WebUI/default.js` (v17), `WebUI/audit_harness.js` (adapter harness, ~654 checks for v17; run `node audit_harness.js default.html`).

v0.18 = v17 + three patch scripts, applied in this order (they live in the chat outputs, not in the repo; re-create from this description if lost):

| Patch | Files it needs | What it does |
|---|---|---|
| `apply_v18_patch.js` | `default.js` | 22 exact-match edits: history/reachability, sampling-gap logic, calibration-dependent checks, default sensor |
| `apply_v18_patch2.js` + `v18_hw_sensors_module.js` | `default.js`, `default.html` | new settings tab "Device sensors" (sensor definitions editor), wide settings window, calibration file DELETE button |
| `apply_v18_patch3.js` + `v18_part3_module.js` | `default.js`, `default.html` | merges the 4 buttons into "Device sensors", history diagnostics and retry, calibration unit switch, sensor id 0 fix |

Each script refuses to write anything unless every search string matches exactly once. If a script fails on the real repo, read its list of failed replacements and adapt: the search strings were copied from the v17 text that was pasted into the chat, which may differ from the repo.

## 2. What changed since v17

### 2.1 Patch 1 (behaviour fixes)
- `deviceSeen` / `statusFails`: the device counts as unreachable only after **3 failed status polls in a row** (or if the first poll fails). `historyUrlFor()` depends on `deviceSeen` ("a device was found"), not on the last poll.
- **Gap logic uses the sample counter.** `timeStepIsGap(t,id)`: a time step above 1.5 periods is a gap only if the id is not `last+1`. Used for cancelling measurements and long recordings. `analysisGaps`: with counters present, timestamp irregularities with a contiguous counter are counted as **jitter** (shown in the detail text, not a failure); `analysisSegments` takes counters and does not cut at jitter.
- **`sensor.hasOwnCal`** (true for the test signal; set by `activateCalibration`, `adoptCalibrationFile`; reset for "demo calibration"). Without it: the calibrated-range check is skipped (`analyzeInterval` passes no `outOfRangeCount`) and the **overload/underload monitor does not run** (it used to read counts as grams through the demo calibration).
- Test signal starts **paused**; the first listed real sensor becomes the shown one after startup (`selectDefaultSensor`); the sensor list shows the test signal **last**.

### 2.2 Patch 2: "Device sensors" tab (Settings Menu, now wide)
- Edits a **draft** of the whole `sensors.json` (starts from `sensorsDoc()`, so WebUI-owned keys are included). Add HX711 load cell / temperature channel (next free id, editable until sent), remove, discard.
- Form covers all keys: id, name, notes, kind, type, enabled, unit, rawFormat, rate_hz, ringbuffer_size_samples, `hx711.{dout_gpio,sck_gpio,rate_gpio,gain}`, `warnings.{overload,underload}.{enabled,threshold,hysteresis}`, `attachedTo`, `conversion`. **No default pins** (docs: no board-specific GPIO assumptions). A JSON box shows/edits the complete entry so unknown keys survive.
- `hwValidate`: id unique/whole, name, kind, type, rawFormat, rate (HX711: 10 or 80), ring buffer positive integer, HX711 pins (DOUT != SCK), gain, warnings numbers (hysteresis >= 0), aux conversion and `attachedTo`.
- `hwApply`: validates, confirms (removed sensors, `buffer=clear` warning), `PUT /data/settings/sensors.json?buffer=preserve|clear` via `serverWrite` (CSRF, 401 dialog), shows the `{status, pendingChanges}` answer, then reloads the sensor list and polls status. Nothing restarts automatically.
- Calibration file **DELETE** button (Sensor tab, next to the calibration file select): `DELETE /data/calibration/<file>` with confirmation.
- Firmware only implements HX711 (`ESP32_Implementation-Status.md`); the form also offers "temperature", which the device may reject.

### 2.3 Patch 3
- The four buttons (**Load older history**, **Validate & send**, **Download**, **Load sensors.json…**) are now in "Device sensors". The old "Apply & send" is gone. The Sensor tab (name, notes, load limits, use conditions, primary temperature channel) now **applies to the session on every change** (`sensorSettingsApplyLocal`); `sensorSettingsApply` still exists in the file but is unused (dead code to remove).
- At send time `hwMergeWebKeys` merges both tabs: for `name, notes, calibrationFile, primaryTemperatureSensorId, loadLimits, conversion`, a value changed in the draft (or loaded from a file) wins; otherwise the session value wins.
- Download and Load work on the **draft** (Load does not send).
- History button follows the sensor selected in "Device sensors" (load cells and aux channels); `noOlder` can be overridden after a confirmation.
- Function wrappers (`historyLoadOlder`, `historyScheduleInitial`, `handleStatus`, `hwRender` are reassigned, which works because they are function declarations): every history decision is written to the **Device log pane and the console** (`[history] <id> ...`, type `webui_history`); every status poll **retries** a sensor whose automatic history never started.
- Calibration: the first calibration a sensor gets switches its display unit from `raw` to the default mass unit (before, it stayed in counts until a reload adopted the file). The "(not bound to a sensor yet)" text no longer fires for sensor id **0** (`sensorId?` was falsy for 0).

## 3. Findings from the first real-ESP32 test (user, on v17)
Reported and what was done:
1. Wizard: empty-platform recording stopped with "sampling gaps"; same through a selected interval in Advanced mode (details: `165 gaps (165 missing)`, `counter: 0 jumps`, i.e. **no samples were lost, only timestamp jitter**). Fixed in patch 1 (§2.1), **not yet confirmed on the device**.
2. "Calibrated range: 2129 of 2129 outside": no calibration yet, demo curve (4600 to 5400 counts) applied to real counts. Fixed (check skipped without `hasOwnCal`).
3. Overload warning without calibration (counts read as grams). Fixed (monitor needs `hasOwnCal`).
4. "No history server configured" and history not loading: see §4 (still open).
5. Test signal was the default shown sensor and ran by default. Fixed (paused; real sensor shown first; the existing Pause/Start button controls it).
6. Sensor creation and hardware fields missing. Done (patch 2). Settings window larger. Done.
7. A wizard-created calibration "was applied" but only worked after sending it to the server; also "not bound to a sensor". Probable causes fixed in patch 3 (unit stayed raw; sensor id 0 falsy). **Not confirmed; ask the user what the display showed.**

## 4. OPEN: history does not load (top priority for the next session)
Console log after patch 3 (sensor id 0, real device at 192.168.0.115):
```
[history] 0 load older: url /api/history, first id 290968, floor 0, noOlder false, running false, samples 27/100000
[history] 0 result: complete (server has nothing older), loaded 0
```
What this shows:
- The WebUI path is fine now: URL present, `noOlder` false, not running. A first request **was** sent (status "complete" is only set after a response with zero records).
- `floor 0` means `history.minId` was never set: the WebUI **does not know the device's oldest retained id**, although `handleStatus` is supposed to take it from `/api/status` `sensors[].oldestId`. Either the firmware sends the field under another name/location, or it is missing for this sensor.
- The first id is 290968 (about one hour of 80 Hz samples). The WebUI asks for ids `285968..290967` (chunk of 5000). The device ring buffer holds only `ringbuffer_size_samples` (**1600 samples = 20 s at 80 Hz** in the example config), so most of that range is evicted. The protocol says: if the range is partly evicted, return the retained part and report the real range in the headers. The device apparently returned **no records**.
- Design bug on the WebUI side: `historyLoadOlder` treats an **empty** answer as "nothing older, complete" (`h.minId = to+1`), without looking at `X-History-Oldest-Id` / `X-History-Latest-Id`. An empty answer to a range that was only partly evicted should be retried with `from = Oldest-Id`.

Next steps (in this order):
1. In the browser Network tab (or `curl`), look at the real answer: `/api/history?sensor_id=0&from_id=285968&to_id=290967&limit=5000&format=bin` and the same with a range inside the last 1600 ids. Record status code, `X-History-*` headers, body length.
2. Look at `/api/status` `sensors[0]`: are `oldestId` / `latestId` present and sensible?
3. Decide where the bug is: **firmware** (returns nothing when `from_id` is older than the oldest retained id, against `OpenScale - API Protocol.md` §4.1) or **WebUI** (see below). Report firmware issues to the user (they check the ESP code).
4. WebUI fix regardless: log `historyFetchChunk` request and response headers; on an empty chunk read `Oldest-Id`/`Latest-Id`, set `minId` from them, and retry once with `from = max(Oldest-Id, ...)`; clamp the first request to `status.oldestId` when known; only then declare "complete". Also tell the user in the UI that the device history is limited to its ring buffer size (1600 samples by default, i.e. about 20 s), so "older history" cannot be long unless the buffer is enlarged in "Device sensors".
5. Keep the diagnostics (`webui_history` log lines) until this is solved.

## 5. Decisions of the user on the v17 §2 list
1. Active calibration vs. saved default: fine as is.
2. **Epoch trigger latency** (config change is only noticed on the next status poll, up to 3 s; samples in between land in the old buffer, possibly decoded with the old `rawFormat`): keep as **"possible todos"** (§7).
3. Archived channel (aux channel whose own `configRevision` changed): **add it to the sensor selection and add a log entry.** Not done yet (§6).
4. Flags (explained to the user): raw values (and `n`, `t`) are **still stored**; only the per-sample **flags** are not stored. Bits 2 to 4 are counted in `state.flagged`; bit 4 on an aux channel stores that reading as NaN; bits 0/1 are ignored (own overload logic + firmware `warning` events).
5. int64/uint64 above 2^53 lose low bits in JS numbers: keep as **future todo**.
10. UIs without a UI so far: add all **except** static-asset PUT and `unixtimestamp`. Done: calibration DELETE, `?buffer=preserve|clear`. **Open:** Wi-Fi / `settings.json` editing (§6).
Everything else in §2 of the v17 handout stays as written there.

## 6. Pending work, in suggested order
1. **History** (§4).
2. **Confirm patches 1 to 3 on the real device** (gaps, range check, overload, default sensor, calibration unit, sensor tab merge). Then commit as `[WebUI] v0.18 ...` with Claude co-author.
3. **Archived aux channel** in the sensor selection (`auxChannels` entries with `archived: true`, id `<id>@<epoch>`, currently not selectable) plus a log entry when it is created. Log both in the sensor log and in the device log (`deviceLogLocal`).
4. **Wi-Fi and `settings.json` editor UI** (GET/PUT/DELETE protected; password fields write-only: omitted = keep, string = set, `null` = remove; `passwordSet` read-only; Wi-Fi list PUT is the complete list, ids match, no id = new, omitted id = deleted; server returns the redacted configuration under the property `configuration`).
5. **Update `audit_harness.js`**: it assumes the demo calibration applies to server sensors (overload on hidden sensors, range checks, V15h, wizard tests); with `hasOwnCal` several checks fail by design. Add tests for: counter-contiguous jitter (no gap, no cancel), `hasOwnCal` guard, `hwValidate`, `hwMergeWebKeys`, `historyUrlFor` with `deviceSeen`, unit switch on first calibration, id 0 binding text.
6. Remove dead code (`sensorSettingsApply`, `applySensorsFile` if unused) and fold the three patch modules into `default.js` cleanly.
7. Update the handout/doc references that still say "Apply & send sensors.json" (user-visible texts and `OpenScale` docs, if any mention it).
8. ESP-side notes to pass on (user checks the firmware): timestamp must be taken at sample read (docs); HTTP server socket limits (`max_open_sockets`, `lru_purge_enable`) because SSE keeps sockets open while the browser polls status/history; history behaviour for partly evicted ranges (§4); `oldestId` in `/api/status`.

## 7. To keep in this handout until resolved (user lists)
**Possible todos:** epoch trigger latency (§5 item 2): consider asking for a status poll when `n`/`t` anomalies or a PUT response says `needs-sensor-reconfig`, and reload the sensor list after that.
**Future todo:** int64/uint64 precision above 2^53 (§5 item 5).

**Minor, for next iteration:**
- Auto-Tare should use an average. UI undecided/unclear.
- "Use as Tare" for finished measurements.
- Toggle to change the chart time axis from seconds to wall clock.
- Default sensor selection: currently the first real sensor, test signal last in the list; save the default in the WebUI settings.
- Device status UI.
- Wall clock for logs and selections as well; always make both available through the DOM `title`.

**Questions for the next iteration:**
- UI library before the GUI advances much further: the user wants Claude's **recommendations** to check first (write them down; not done yet).
- Is test-signal generation paused when not selected? Now: paused by default (patch 1), started with the Pause/Start button; a hidden running test signal still records raw samples in the background. Decide whether it should be paused when not shown.
- Idea for later: estimate the real sample interval from the median timestamp difference instead of `rate_hz` (would make all validity checks more robust on a real device). Wall-clock jitter handling: not yet.

**Problems, for later:**
- With a real sensor the graph is stuttery, only for noise of a steady platform **and** on large chart windows (small windows fine, test signal fine). Cause unknown. Ideas to test: per-frame cost of `buildEstimatorCurve` / `windowNeff` / `windowStability` / `analysisAutocorr` with large windows, uPlot redraw of a flat noisy line, mini-chart bucket rebuilds, Y-axis damping re-rendering on every frame (`yBusy`), JS GC from `Array`-based helpers; profile in the browser first.

**Features for later:**
- Split button "Clear local".
- Storing measurements in 3 ways: **Session, Browser, Device** (device unsupported for now). A small button/menu beside measurements to move one between the categories; default Session, default selectable in the WebUI settings.
- **Raw storage**: v17 switched `state.raw` to `Float64Array`. The user finds this suboptimal: it invalidates the earlier raw-storage approach and is twice as large as needed for 32-bit raw. Needs a design: keep a typed array per `rawFormat` (Int32Array / Uint32Array / Float32Array) and use Float64Array only for 64-bit formats; keep the lossless parse step.

**Older reminders (from handout v16 §0, still open):** buoyancy compensation (also conventional mass vs. true mass, see the Claude review of the mathematical record), "License Info" in the menu, temperature correction as its own epoch, OIML table, CSV sample-id column, checkweighings UI (format only exists), navigator display of channels, per-channel pause, UI for device-log filtering by type, wall-clock labels from `unixtimestamp`, a mock ESP server for browser tests, memory use of many archived epochs (total sample budget).

## 8. Browser checklist (still never done)
All items of the v17 checklist, plus: Device sensors tab (add / edit / remove / send with `buffer=preserve|clear`, `needs-sensor-reconfig` answer, restart flow) · Sensor tab auto-apply and merge with the draft · Download/Load sensors.json · history button and Device-log `webui_history` lines · gap handling on the real device (empty-platform recording, Advanced selection) · first calibration switches the display to mass · sensor id 0 text · calibration DELETE · status poll tolerance (3 failures) · default sensor and paused test signal.

## 9. Facts for the next session
- Real device used: ESP32 at `192.168.0.115`, sensor id 0, HX711; stream ids around 290968 after about one hour of uptime.
- Test-signal and demo calibration are fixtures only (4600 to 5400 counts = 0 to 200 g); real HX711 counts are in the millions.
- `ringbuffer_size_samples` in the example config is 1600 (20 s at 80 Hz); the WebUI buffer is 100,000 samples by default.
- The previous Claude review of the mathematical record (`docs/Mass_Telemetry_Workbench_Claude-Sonnet-5.5_Response_to_Mathematical_Record.md`) found no wrong formulas; most points (shifted/Welford sums, normalised EMA, Hampel scale floor) were already addressed in v17 code. The decision-record document itself may not yet reflect the review; check before relying on it.
