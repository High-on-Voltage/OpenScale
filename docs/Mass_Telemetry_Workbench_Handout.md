# Mass Telemetry Workbench: handout v15 (read after v14 and v14.1; overrides them where they differ)

Baseline: `telemetry_workbench_v15.html` + `.js`, `audit_harness_v15.js` (run `node audit_harness_v15.js telemetry_workbench_v15.html`). All v14 checks run unchanged and pass; the v15 checks are added at the end of the harness. **Still not browser-tested.**

## 1. Decisions from the user (this session)
- Differences of temperature are always in K, values in °C (for v14.1).
- Simple mode shows the extra checks (v14.1) as three steps.

## 2. What v15 implements
| Request | Where / how |
|---|---|
| Track Live ⇄ **Pause Tracking** | one button; pausing freezes the view and the automatic "back to live at the right edge" is switched off until Track Live is pressed (`state.trackPaused`) |
| Window slider logarithmic | slider 0..1000 maps to 2..10,000 samples (`sliderToWindow`, `windowToSlider`); the number fields are unchanged |
| Sub-pixel rendering (**testing**) | Display options checkbox, off by default = uPlot `pxAlign: 1`; on = `pxAlign: 0`. Stored in `ui-settings.json` as `subPixel` (additive) |
| Clear charts / Clear all charts / Clear all | collapsed "Clear data…" at the very end of the Settings panel, with a confirmation. Calibrations are never deleted. *Clear charts*: samples of the shown sensor. *Clear all charts*: samples of every sensor. *Clear all*: also tares, log, measurements, overload events of every sensor |
| **Overload / underload warning** | per sensor, see §3 |
| **Connection timeout** | see §4 |
| **Calibration file per sensor** | see §5 |

## 3. Overload warning (my reading of the request, please check)
- Limits are **weights** (value + unit, stored as mg). Maximum empty = warning off. Minimum optional; without it **−maximum** is used.
- The load is the **gross** calibrated mass (the tare is ignored, the cell does not know it), averaged over the newest **0.1 s** of samples (adjustable). It runs for **every** sensor, also those that are not shown.
- Level = *excess* over the limit: `(avg − max) / max` (below the minimum: `(min − avg) / |min|`). **Yellow > 10 %, orange > 20 %, red > 40 %** excess (all three adjustable; the red default of 40 % is my choice, you did not name one). I read "(>10 % max load)" as the excess above the limit. A load that is above the limit by less than the yellow threshold shows nothing; set yellow to 0 if you want every exceedance flagged.
- An **event** starts at the first sample with a level and ends when no level was seen for **0.5 s** (adjustable; shorter dips stay one event). Duration, peak mass, peak level and side (over / under) are stored. Time = device sample time.
- Display: a large banner at the top of the page (sticky, one line per sensor, click = show that sensor). It pulses and says **STILL OVERLOADED** while the load is over the limit, otherwise "ended N s ago", and stays for **8 s** after the incident (adjustable). "no data (status unknown)" if the stream is silent.
- Charts: a coloured band over the event's time range (and a stripe at the top edge) in the main chart and the navigator. Log: an `overload` entry per closed event (hover, click to jump). Hidden sensors keep their own log.
- Settings: Settings Menu → **Sensor** tab (the test signal is listed there too, so you can try it: set a maximum of e.g. 150 g). Stored in `sensor_settings.json` per sensor as `overload: {maxLoad:{value,unit}, minLoad, averageS, yellowPercent, orangePercent, redPercent, breakS, holdS}`. New button "Load sensor_settings.json…" reads such a file back.
- Not done: limits in raw counts; history merged into the buffer is not run through the monitor.

## 4. Connection timeout
A sensor that should stream (not paused, listed, connection open, or the test signal) but delivers no sample for `max(2 s, 20 × nominal period)` is shown as "No data for N s": red status dot, ⏱ in the sensor list, not counted as streaming. A timer (500 ms) updates it; any sample, resuming a sensor or a new connection resets it. Constants: `STREAM_TIMEOUT_MIN_MS`, `STREAM_TIMEOUT_PERIODS`.

## 5. Calibration files belong to one sensor
- New top-level key `sensorId` in the calibration file (additive, `schemaVersion` 1). The wizard writes it. File name: **`calibration_<profileId>.json`** (export and wizard export).
- A calibration naming another sensor than the shown one is refused. Importing such a file **switches to its sensor** and activates it there; a file for an unknown sensor is rejected; an old file without `sensorId` is bound to the shown sensor (with a notice). Export stamps the sensor id and recomputes revision id and content hash for the stamped content.
- **Active file per sensor**: `sensor_settings.json` → `calibrationFile`. Settings Menu → Sensor tab has a selector (embedded demo + the files of that sensor known in this session). Loading `sensor_settings.json` activates the named files that are known; unknown names are reported and kept as pending.
- Optional `CALIBRATION_FILES_URL` (null for now): GET `<url>/<file name>` for a server library. **Open:** the server must provide the file list and storage; the browser only keeps files in memory for the session.
- Every sensor already had its own calibration state; only the file binding, naming and selection are new.

## 6. Not done yet (v14.1 spec, next round)
`characterization` block (eccentricity, creep, zero drift, temperature sensitivity), wizard tab "5 Characterization" and the Simple "Extra checks" (three steps), auxiliary channels (`kind`, conversions, `deviceId`/shared time origin, aux ring buffers, right-hand axis, `aux_<id>` CSV columns), use conditions, the four new uncertainty components, `checkweighings.json` format. Nothing of it was started.

## 7. Browser checklist (new items marked ★)
All v14 items, plus ★ overload banner (size, wrapping, sticky behaviour, colours in light and dark mode), ★ event bands in both charts and the top stripe, ★ Pause Tracking button state while panning and selecting, ★ log slider feel, ★ sub-pixel rendering on / off (does the chart look sharper or blurrier), ★ Clear data… confirmations, ★ Sensor tab layout with the new fields, ★ timeout display with a real unplugged stream.
