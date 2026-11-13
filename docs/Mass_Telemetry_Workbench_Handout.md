# Mass Telemetry Workbench: changes in v12 (read after the v11 handout; this overrides it where they differ)

Files: `telemetry_workbench_v12.html` + `telemetry_workbench_v12.js` (keep together), `audit_harness_v12.js` (`node audit_harness_v12.js telemetry_workbench_v12.html`; 190 checks pass = v11's 160 + W1-W8), `sensors_example.json` unchanged.
**Not opened in a browser** (neither v11 nor v12): modal layout, SVG plots, focus/Esc behaviour, localStorage in a real browser, wizard with a live stream.

## 1. Settings Menu (hovering)
- Settings dropdown > "Open Settings Menu…" opens a modal with tabs **Interface** and **Sensor** (Esc / click outside closes).
- **Interface:** UI settings are stored automatically in the browser (localStorage key `massTelemetryWorkbench.uiSettings.v1`) as `ui-settings.json` content: theme, navigation panel, Y-response, downsampling, zero fills, zero line. Precedence: browser copy > server default > built-in. Applying never writes. Buttons: Reset UI settings (forgets the browser copy, applies server default or built-in), Export ui-settings.json, Save current as server default, Reset server default.
- **Sensor:** display name, nominal rate (editable only while the sensor has no samples), notes. "Apply & send" PUTs `sensor_settings.json` (`{schemaVersion, generatedAt, sensors:[{id,name,nominalRateHz,notes}]}`, all server sensors) to `SENSOR_SETTINGS_URL`; "Download" saves it. The test signal has no settings.
- **ASSUMED server API** (both URLs are `null`, server buttons disabled, nothing is sent): `UI_SETTINGS_URL` GET (200 JSON | 404 none) / PUT / DELETE; `SENSOR_SETTINGS_URL` PUT. Navigation panel visibility is now persisted (decision from v11 reversed).
- Decision to confirm: "Reset UI settings" falls back to the *server default* if one exists.

## 2. Calibration wizard and fitting editor (Settings > Calibration wizard & fitting editor…)
Four free-order tabs: **1 Weights** (profile, reference weights with nominal/assigned mass and unit, combination loads), **2 Observations**, **3 Fit**, **4 Review**. "Load the active calibration" imports its observations for refitting (the demo can be refitted).
- **Observations** store RAW counts (independent of tare and active calibration): record N seconds from the shown sensor (reuses the Measurement machinery via `beginMeasurement(target, hooks)`: highlighted, logged, cancelled by tare/gap), use the selected interval, or type a value. Each gets `analyzeSeries` validity; an `invalid` one starts excluded. Placement index and "removed and replaced" are stored.
- **Fit models:** piecewise-linear through group means (= v11 behaviour), straight line, quadratic, cubic. Polynomials are fitted as **counts on mass** (noise is in the counts; avoids regression dilution), equal weights, in a normalised variable. The engine is unchanged: the file contains anchors **sampled on the fitted curve** (segments doubled until the deviation from the exact inverse is < 1e-5 of the mass span, max 256; the value is shown and stored in `fit.maxInterpolationErrorMg`). Non-monotonic fits and too few masses are rejected. Fit block + all observations (excluded ones marked `excluded`) are written into the same `schemaVersion` 1 file. Reference masses with different assigned masses are not merged.
- Fit tab: model comparison (p, dof, residual SD, RMS, max), plots (counts vs mass with curve, residuals), replicate scatter per mass, residual table. Residuals are observed scatter, **not** uncertainty; `validation.status` stays `not-characterized`.
- Review: errors/warnings, Activate on the shown sensor (new epoch, tare reset), Export JSON. The wizard is bound to one sensor.

## 3. Open items
- Weighted least squares (weights from between-placement variance), hysteresis / loading direction, temperature, uncertainty budget, leave-one-out, outlier tests on observations.
- Server-side persistence of calibrations; real SSE/ESP32 format; per-sensor counter storage.
- Browser checklist: wizard recording with a live chart, minimise bar, plots at narrow widths, settings persistence across reload, Esc handling.
